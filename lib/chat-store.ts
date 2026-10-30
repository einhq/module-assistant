/**
 * Durable assistant conversations.
 *
 * Each user owns a private `$HOME/.chats` directory. Every child is one log and
 * every log entry is one user or assistant message. Keeping conversations in
 * separate logs makes deletion, listing and concurrent chats independent while
 * preserving the append-only history of each conversation.
 */

import type { Command, Node, ResourceHandleIf } from '@ein/client';
import type { AssistantProposal, CommandResult, ProposalOutcome } from './reply.ts';
import type { ChatMessage, ChatSummary, StoredChatMessage } from './api.ts';
export type { StoredChatMessage } from './api.ts';

const CHATS_DIRECTORY = '.chats';
const CHAT_TITLE_ATTR = 'chatTitle';
const CHAT_UPDATED_AT_ATTR = 'chatUpdatedAt';
const CHAT_MESSAGE_COUNT_ATTR = 'chatMessageCount';
/** What the model is given before the conversation: see `ModelContext`. */
const CHAT_MODEL_CONTEXT_ATTR = 'chatModelContext';

const CHAT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const READ_BATCH = 500;
const MAX_MESSAGES = 10_000;

type LogEntry = { id: number; createdAt: Date; data: unknown };
type ChatLogHandle = ResourceHandleIf & {
  readEntries(size: number, signal?: AbortSignal): Promise<LogEntry[]>;
  appendAt(data: unknown, createdAt?: Date): Promise<number>;
};

const isChatLogHandle = (handle: ResourceHandleIf): handle is ChatLogHandle =>
  typeof (handle as Partial<ChatLogHandle>).readEntries === 'function' &&
  typeof (handle as Partial<ChatLogHandle>).appendAt === 'function';

const homePath = (cmd: Command): string => {
  const home = cmd.env.HOME;
  if (!home || home === '/') throw new Error('chat requires a logged-in user home');
  return home.replace(/\/$/, '');
};

const chatsPath = (cmd: Command): string => `${homePath(cmd)}/${CHATS_DIRECTORY}`;

const assertChatId = (id: string): string => {
  if (!CHAT_ID.test(id)) throw new Error(`invalid chat id '${id}'`);
  return id;
};

const chatPath = (cmd: Command, id: string): string => `${chatsPath(cmd)}/${assertChatId(id)}`;

const isoFromTimestamp = (timestamp: number): string => new Date(timestamp).toISOString();

const summaryFromNode = (id: string, node: Node): ChatSummary => {
  const createdAt = isoFromTimestamp(node.props.birthtime.timestamp);
  const updatedAt = typeof node.attrs[CHAT_UPDATED_AT_ATTR] === 'string' ? node.attrs[CHAT_UPDATED_AT_ATTR] : isoFromTimestamp(node.props.modtime.timestamp);
  return {
    id,
    title: typeof node.attrs[CHAT_TITLE_ATTR] === 'string' && node.attrs[CHAT_TITLE_ATTR].trim() ? node.attrs[CHAT_TITLE_ATTR] : 'New chat',
    createdAt,
    updatedAt,
    messageCount: typeof node.attrs[CHAT_MESSAGE_COUNT_ATTR] === 'number' ? node.attrs[CHAT_MESSAGE_COUNT_ATTR] : 0,
  };
};

const validMessage = (data: unknown): data is StoredChatMessage => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const message = data as Partial<StoredChatMessage>;
  return (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string';
};

const titleFromMessage = (message: string): string => {
  const oneLine = message.trim().replace(/\s+/g, ' ');
  return oneLine.length > 60 ? `${oneLine.slice(0, 59).trimEnd()}…` : oneLine || 'New chat';
};

/**
 * Create or repair the private chat directory for this shell's user. It takes the user's own uid
 * and primary gid rather than the home's: a home may be in a group its user is not in, and only
 * the administrator gives a node such a group.
 */
const ensureChatsDirectory = async (cmd: Command): Promise<string> => {
  const path = chatsPath(cmd);
  const props = { uid: cmd.access.uid, gid: cmd.access.gid, mode: 0o700 };
  const directory = await cmd.sys.vfs.ensure(cmd.access, 'directory', homePath(cmd), CHATS_DIRECTORY, { props });
  if (directory.type !== 'directory') throw new Error(`chat path is not a directory: ${path}`);
  await cmd.sys.vfs.update(cmd.access, path, { props });
  return path;
};

export const listChats = async (cmd: Command): Promise<ChatSummary[]> => {
  const parent = await ensureChatsDirectory(cmd);
  const entries = await cmd.sys.vfs.children(cmd.access, parent);
  return entries
    .filter((entry) => entry.node.type === 'log' && CHAT_ID.test(entry.name))
    .map((entry) => summaryFromNode(entry.name, entry.node))
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
};

export const createChat = async (cmd: Command): Promise<ChatSummary> => {
  const parent = await ensureChatsDirectory(cmd);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const node = await cmd.sys.vfs.create(cmd.access, 'log', parent, id, {
    props: { uid: cmd.access.uid, gid: cmd.access.gid, mode: 0o600 },
    attrs: {
      retention: 'forever',
      [CHAT_TITLE_ATTR]: 'New chat',
      [CHAT_UPDATED_AT_ATTR]: now,
      [CHAT_MESSAGE_COUNT_ATTR]: 0,
    },
  });
  return summaryFromNode(id, node);
};

export const readChat = async (cmd: Command, id: string): Promise<{ chat: ChatSummary; messages: ChatMessage[] }> => {
  const path = chatPath(cmd, id);
  const node = await cmd.sys.vfs.get(cmd.access, path);
  if (node.type !== 'log') throw new Error(`chat is not a log: ${id}`);
  const handle = await cmd.sys.vfs.open(cmd.access, path, { mode: 'r' });
  try {
    if (!isChatLogHandle(handle)) throw new Error(`chat is not a log: ${id}`);
    const messages: ChatMessage[] = [];
    while (messages.length < MAX_MESSAGES) {
      const entries = await handle.readEntries(Math.min(READ_BATCH, MAX_MESSAGES - messages.length));
      if (entries.length === 0) break;
      for (const entry of entries) {
        if (validMessage(entry.data)) messages.push({ ...entry.data, id: String(entry.id), timestamp: entry.createdAt.toISOString() });
      }
      if (entries.length < READ_BATCH) break;
    }
    settleProposals(messages);
    return { chat: summaryFromNode(id, node), messages };
  } finally {
    await handle.close();
  }
};

const outcomeOf = (message: StoredChatMessage): ProposalOutcome | undefined => {
  const outcome = message.outcome;
  if (!outcome || typeof outcome !== 'object') return undefined;
  const { of, status, error, results, script } = outcome as Partial<ProposalOutcome>;
  if (typeof of !== 'string' || (status !== 'ran' && status !== 'failed' && status !== 'dismissed')) return undefined;
  return {
    of,
    status,
    ...(typeof error === 'string' ? { error } : {}),
    ...(Array.isArray(results) ? { results } : {}),
    ...(typeof script === 'string' ? { script } : {}),
  };
};

const isCommandResult = (value: unknown): value is CommandResult => {
  const result = value as Partial<CommandResult> | null;
  return !!result && typeof result === 'object' && typeof result.command === 'string' && typeof result.ok === 'boolean' && typeof result.output === 'string' &&
    (result.exitCode === undefined || typeof result.exitCode === 'number');
};

/** The drawer's account of what each command said, as JSON; anything else is refused. */
export const parseResults = (raw: string): CommandResult[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('results must be JSON');
  }
  if (!Array.isArray(parsed) || !parsed.every(isCommandResult)) throw new Error('results must be an array of {command, ok, exitCode?, output}');
  return parsed.map((result) => ({ ...result, output: result.output.slice(0, 4000) }));
};

/**
 * The log is append-only, so a proposal's fate is a later message that names it. Mark each
 * proposing message with its outcome, so the drawer can show the card settled and nothing
 * else has to walk the log.
 */
const settleProposals = (messages: ChatMessage[]): void => {
  const byId = new Map(messages.map((message) => [message.id, message]));
  for (const message of messages) {
    const outcome = outcomeOf(message);
    if (!outcome) continue;
    const proposing = byId.get(outcome.of);
    if (proposing && proposing.proposal && !proposing.settled) {
      proposing.settled = {
        status: outcome.status,
        at: message.timestamp,
        ...(outcome.error ? { error: outcome.error } : {}),
        ...(outcome.results ? { results: outcome.results } : {}),
        ...(outcome.script ? { script: outcome.script } : {}),
      };
    }
  }
};

/** The lines of every proposal the user declined since they last wrote, in a chat as `readChat` reads it. */
export const declinedSinceAsked = (messages: ChatMessage[]): string[] => {
  const since = messages.findLastIndex((message) => message.role === 'user');
  return messages.slice(since + 1)
    .filter((message) => message.settled?.status === 'dismissed')
    .flatMap((message) => (message.proposal as AssistantProposal).commands.map((entry) => entry.command));
};

/** How a proposal ended, as the outcome message's content. */
const outcomeContent = (status: ProposalOutcome['status'], labels: string[], error?: string, script?: string): string => {
  // An edited script is what ran; the labels described the proposal, not it.
  const what = script ? `\n${script}` : labels.length ? `\n${labels.map((label) => `• ${label}`).join('\n')}` : '';
  const edited = script ? ' (edited)' : '';
  switch (status) {
    case 'ran':
      return `Done${edited}:${what}`;
    case 'failed':
      return `Failed${edited}${error ? ` (${error})` : ''}:${what}`;
    case 'dismissed':
      return `Declined by the user, not run:${what}`;
  }
};

/**
 * Record how a proposal ended: a new message naming the proposing one. The proposal must be
 * in this chat and still open; a second outcome for the same proposal is refused, so a
 * double click cannot record a run twice.
 */
export const settleProposal = async (
  cmd: Command,
  id: string,
  messageId: string,
  status: ProposalOutcome['status'],
  error?: string,
  results?: CommandResult[],
  script?: string,
): Promise<ChatMessage> => {
  const { messages } = await readChat(cmd, id);
  const proposing = messages.find((message) => message.id === messageId);
  if (!proposing || !proposing.proposal) throw new Error(`message ${messageId} is not a proposal in this chat`);
  if (proposing.settled) throw new Error(`proposal ${messageId} is already ${proposing.settled.status}`);
  const labels = (proposing.proposal as AssistantProposal).commands.map((entry) => entry.label);
  const outcome: ProposalOutcome = {
    of: messageId,
    status,
    ...(error ? { error: error.slice(0, 1000) } : {}),
    ...(results?.length ? { results } : {}),
    ...(script ? { script: script.slice(0, 8000) } : {}),
  };
  const message: StoredChatMessage = { role: 'assistant', content: outcomeContent(status, labels, outcome.error, outcome.script), outcome };
  const appended = await appendChatMessage(cmd, id, message);
  return { ...message, id: appended.id, timestamp: appended.timestamp };
};

export const appendChatMessage = async (cmd: Command, id: string, message: StoredChatMessage): Promise<{ id: string; timestamp: string; chat: ChatSummary }> => {
  if (!validMessage(message)) throw new Error('chat message must have a role and content');
  const path = chatPath(cmd, id);
  const node = await cmd.sys.vfs.get(cmd.access, path);
  if (node.type !== 'log') throw new Error(`chat is not a log: ${id}`);

  const timestamp = new Date();
  const handle = await cmd.sys.vfs.open(cmd.access, path, { mode: 'a' });
  let entryId: number;
  try {
    if (!isChatLogHandle(handle)) throw new Error(`chat is not a log: ${id}`);
    entryId = await handle.appendAt(message, timestamp);
  } finally {
    await handle.close();
  }

  const count = typeof node.attrs[CHAT_MESSAGE_COUNT_ATTR] === 'number' ? node.attrs[CHAT_MESSAGE_COUNT_ATTR] + 1 : 1;
  const title = count === 1 && message.role === 'user' ? titleFromMessage(message.content) : summaryFromNode(id, node).title;
  const updated = await cmd.sys.vfs.update(cmd.access, path, {
    attrs: {
      [CHAT_TITLE_ATTR]: title,
      [CHAT_UPDATED_AT_ATTR]: timestamp.toISOString(),
      [CHAT_MESSAGE_COUNT_ATTR]: count,
    },
  });
  return { id: String(entryId), timestamp: timestamp.toISOString(), chat: summaryFromNode(id, updated) };
};

/**
 * What a chat's model reads before the conversation — the system message (the prompt file and who
 * the user is) and the tools (the commands' own specs) — with a checksum of the two and when this
 * version was first used. Kept on the chat so the log says what every answer was given; each
 * assistant message names the checksum it answered under.
 *
 * A turn compares the stored checksum with the current one. The same: nothing to do, and the chat
 * goes on as an extension of what the model has read. Different (a command changed, the prompt was
 * edited, since the chat last ran): the new context replaces the old one at the top, where the model
 * was trained to find its tools — not a second list further down, which would contradict the first —
 * and the chat is read once from the start (a second or two), then goes on as before.
 */
type ModelContext = { checksum: string; system: string; tools: unknown[]; since: string };

export const readModelContext = async (cmd: Command, id: string): Promise<ModelContext | undefined> => {
  const node = await cmd.sys.vfs.get(cmd.access, chatPath(cmd, id));
  const stored = node.attrs[CHAT_MODEL_CONTEXT_ATTR] as Partial<ModelContext> | undefined;
  if (!stored || typeof stored.checksum !== 'string' || typeof stored.system !== 'string' || !Array.isArray(stored.tools)) return undefined;
  return { checksum: stored.checksum, system: stored.system, tools: stored.tools, since: String(stored.since ?? '') };
};

export const writeModelContext = async (cmd: Command, id: string, context: ModelContext): Promise<void> => {
  await cmd.sys.vfs.update(cmd.access, chatPath(cmd, id), { attrs: { [CHAT_MODEL_CONTEXT_ATTR]: context } });
};

export const deleteChat = async (cmd: Command, id: string): Promise<void> => {
  const parent = chatsPath(cmd);
  const path = chatPath(cmd, id);
  const node = await cmd.sys.vfs.get(cmd.access, path);
  if (node.type !== 'log') throw new Error(`chat is not a log: ${id}`);
  await cmd.sys.vfs.unlink(cmd.access, path, parent);
};
