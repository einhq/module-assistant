import { computed, signal } from '@preact/signals-react';
import type {
  AssistantCard,
  AssistantEvent,
  AssistantFailure,
  AssistantLink,
  AssistantLive,
  AssistantProposal,
  AssistantSearch,
  AssistantStep,
  AssistantTable,
  AssistantTiming,
  ProposalSettled,
} from '../lib/assistant.ts';
import { MediaRef, shq, uuidv4 } from '@ein/ui/lib';
import { replyMediaItems } from '../lib/assistant.ts';
import { currentUser, execCommand, MediaItem } from '@ein/ui/signals';
import type { ChatSummary as WireChatSummary, SuggestedQuestions } from '@assistant/api';
export type { ChatSummary as WireChatSummary } from '@assistant/api';

/** One conversation: a durable one as listed from `$HOME/.chats`, or the guest's in this browser. */
interface ChatSummary {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  messageCount: number;
}

/** One bubble in a conversation log. */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  media?: MediaItem[];
  links?: AssistantLink[];
  search?: AssistantSearch | null;
  proposal?: AssistantProposal;
  cards?: AssistantCard[];
  /** The rows of a command, shown as a table under the answer. */
  table?: AssistantTable;
  /** The type of each node the answer's text links to, by path. */
  nodeTypes?: Record<string, string>;
  /** On a proposal message: how it ended. Absent while the buttons are still live. */
  settled?: ProposalSettled;
  /** On an outcome message: which proposal it settles. */
  outcome?: { of: string; status: ProposalSettled['status']; error?: string };
  steps?: AssistantStep[];
  timeline?: AssistantEvent[];
  /** On a question: asked with "think harder". */
  think?: boolean;
  elapsedMs?: number;
  timing?: AssistantTiming;
  error?: string;
  /** Set with `error`; absent on a transport failure and on a turn stored without one. */
  failure?: AssistantFailure;
}

type WireChatMessage = Omit<ChatMessage, 'timestamp' | 'media'> & { timestamp: string; media?: MediaRef[] };

const summaryFromWire = (chat: WireChatSummary): ChatSummary => ({ ...chat, createdAt: new Date(chat.createdAt), updatedAt: new Date(chat.updatedAt) });
const messageFromWire = ({ media, timestamp, ...message }: WireChatMessage): ChatMessage => ({
  ...message,
  timestamp: new Date(timestamp),
  ...(media ? { media: replyMediaItems({ media }) } : {}),
});

const CHAT_THINK_KEY = 'ein-chat-think';
const storedChatThink = (): boolean => {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(CHAT_THINK_KEY) === '1';
  } catch {
    return false;
  }
};

/**
 * "Think harder": the next questions ask the model to think before every call. Slower (about twice
 * the wait) and more careful with its commands; the viewer's choice, remembered here.
 */
export const chatThink = signal(storedChatThink());
export const setChatThink = (think: boolean) => {
  chatThink.value = think;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(CHAT_THINK_KEY, think ? '1' : '0');
  } catch {
    // A preference that cannot be kept still holds for this page.
  }
};

/**
 * Whether the reader is the guest, who writes nothing on the server and so keeps no chat logs: the
 * guest has one conversation, held here and sent along with each question (`chatHistory`), gone with
 * the page. "New chat" begins it again, and there are no recent chats to offer.
 */
export const guestChat = computed(() => currentUser.value === null);

export const chatSummaries = signal<ChatSummary[]>([]);
export const activeChatId = signal<string | null>(null);
const chatMessagesById = signal<Record<string, ChatMessage[]>>({});
export const chatDrafts = signal<Record<string, string>>({});
export const chatLoadingIds = signal<string[]>([]);
type ChatResponsePhase = AssistantLive['phase'];
const chatResponsePhases = signal<Record<string, ChatResponsePhase>>({});
/** Per chat, the turn in flight as last sampled: its commands and the model's draft. */
const chatLiveTurns = signal<Record<string, AssistantLive>>({});
export const chatsLoading = signal(false);
const chatsLoaded = signal(false);

export const chatMessages = computed(() => activeChatId.value ? chatMessagesById.value[activeChatId.value] ?? [] : []);
export const chatLoading = computed(() => activeChatId.value !== null && chatLoadingIds.value.includes(activeChatId.value));
export const chatResponsePhase = computed(() => activeChatId.value ? chatResponsePhases.value[activeChatId.value] : undefined);
export const chatLiveTurn = computed(() => activeChatId.value ? chatLiveTurns.value[activeChatId.value] : undefined);

let loadedUsername: string | undefined;
let loadPromise: Promise<void> | undefined;
let loadPromiseUsername: string | undefined;
let createPromise: Promise<string> | undefined;

const sortChats = (chats: ChatSummary[]) => chats.toSorted((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

const resetForUser = (username: string | undefined) => {
  loadedUsername = username;
  chatSummaries.value = [];
  activeChatId.value = null;
  chatMessagesById.value = {};
  chatDrafts.value = {};
  chatLoadingIds.value = [];
  chatResponsePhases.value = {};
  chatLiveTurns.value = {};
  chatsLoaded.value = false;
  chatsLoading.value = false;
  createPromise = undefined;
};

const loadChats = async (): Promise<void> => {
  const username = currentUser.value?.username;
  if (loadedUsername !== username) resetForUser(username);
  if (!username || chatsLoaded.value) return;
  if (loadPromise && loadPromiseUsername === username) return await loadPromise;

  chatsLoading.value = true;
  const pending = (async () => {
    const result = await execCommand<{ chats: WireChatSummary[] }>('assistant-chat list');
    if (loadedUsername !== username || currentUser.value?.username !== username) return;
    chatSummaries.value = sortChats(result.chats.map(summaryFromWire));
    chatsLoaded.value = true;
  })();
  loadPromise = pending;
  loadPromiseUsername = username;
  try {
    await pending;
  } finally {
    if (loadPromise === pending) {
      loadPromise = undefined;
      loadPromiseUsername = undefined;
      chatsLoading.value = false;
    }
  }
};

export const openChat = async (id: string): Promise<void> => {
  await loadChats();
  if (!chatSummaries.value.some((chat) => chat.id === id)) throw new Error(`chat not found: ${id}`);
  activeChatId.value = id;
  if (Object.hasOwn(chatMessagesById.value, id)) return;
  const result = await execCommand<{ chat: WireChatSummary; messages: WireChatMessage[] }>(`assistant-chat read ${shq(id)}`);
  const summary = summaryFromWire(result.chat);
  chatSummaries.value = sortChats(chatSummaries.value.map((chat) => chat.id === id ? summary : chat));
  // An outcome message settles a proposal's card (the log already joined them); it is not a bubble of its own.
  chatMessagesById.value = { ...chatMessagesById.value, [id]: result.messages.filter((message) => !message.outcome).map(messageFromWire) };
};

/**
 * A new chat is being made. Until it exists the input still belongs to the chat before it, so it
 * waits: a question typed in that moment would go to the old chat, and the new one then take the drawer.
 */
export const chatCreating = signal(false);

/** Questions the installed modules suggest asking, for a chat with nothing in it yet; null until asked. */
export const chatExamples = signal<string[] | null>(null);

/** Ask once for the suggested questions; none when they cannot be read. */
export async function loadChatExamples(): Promise<void> {
  if (chatExamples.value !== null) return;
  try {
    chatExamples.value = (await execCommand<SuggestedQuestions>('assistant-chat examples')).examples;
  } catch {
    chatExamples.value = [];
  }
}

export const createChat = async (): Promise<string> => {
  await loadChats();
  const username = currentUser.value?.username;
  const current = activeChatId.value;
  if (current && Object.hasOwn(chatMessagesById.value, current) && chatMessagesById.value[current].length === 0) return current;
  if (!username) return beginGuestChat();
  if (createPromise) return await createPromise;
  const pending = (async () => {
    const result = await execCommand<{ chat: WireChatSummary }>('assistant-chat create');
    const chat = summaryFromWire(result.chat);
    if (loadedUsername !== username || currentUser.value?.username !== username) return chat.id;
    chatSummaries.value = sortChats([chat, ...chatSummaries.value]);
    chatMessagesById.value = { ...chatMessagesById.value, [chat.id]: [] };
    activeChatId.value = chat.id;
    return chat.id;
  })();
  createPromise = pending;
  chatCreating.value = true;
  try {
    return await pending;
  } finally {
    if (createPromise === pending) {
      createPromise = undefined;
      chatCreating.value = false;
    }
  }
};

/** The guest's conversation, begun anew in place of the one before. */
const beginGuestChat = (): string => {
  const now = new Date();
  const chat: ChatSummary = { id: uuidv4(), title: 'New chat', createdAt: now, updatedAt: now, messageCount: 0 };
  chatSummaries.value = [chat];
  chatMessagesById.value = { [chat.id]: [] };
  chatDrafts.value = {};
  activeChatId.value = chat.id;
  return chat.id;
};

/**
 * The guest's conversation before its last question, as `assistant-ask --history` takes it: what
 * each side said, without the apologies for answers that never came.
 */
export const chatHistory = (chatId: string): { role: 'user' | 'assistant'; content: string }[] =>
  (chatMessagesById.value[chatId] ?? []).slice(0, -1).filter((message) => !message.error).map(({ role, content }) => ({ role, content }));

/** The pictures the conversation has shown, newest first, so the next answer offers new ones. */
export const chatShown = (chatId: string): string[] => [
  ...new Set((chatMessagesById.value[chatId] ?? []).toReversed().flatMap((message) => (message.media ?? []).map((item) => item.path))),
];

/**
 * Open the chat a link names, when the user has it; otherwise the active one, the latest, or the
 * user's first.
 */
export const ensureActiveChat = async (preferred?: string): Promise<void> => {
  await loadChats();
  if (preferred && chatSummaries.value.some((chat) => chat.id === preferred)) {
    await openChat(preferred);
    return;
  }
  if (activeChatId.value) {
    await openChat(activeChatId.value);
    return;
  }
  const latest = chatSummaries.value[0];
  if (latest) await openChat(latest.id);
  else await createChat();
};

export const deleteChat = async (id: string): Promise<void> => {
  if (chatLoadingIds.value.includes(id)) return;
  await execCommand(`assistant-chat delete ${shq(id)}`);
  if (activeChatId.value === id) activeChatId.value = null;
  chatSummaries.value = chatSummaries.value.filter((chat) => chat.id !== id);
  const { [id]: _removed, ...remaining } = chatMessagesById.value;
  chatMessagesById.value = remaining;
  const { [id]: _draft, ...remainingDrafts } = chatDrafts.value;
  chatDrafts.value = remainingDrafts;
};

export const setChatDraft = (id: string, draft: string) => {
  chatDrafts.value = { ...chatDrafts.value, [id]: draft };
};

export const addChatMessage = (
  chatId: string,
  role: 'user' | 'assistant',
  content: string,
  extra: Partial<Omit<ChatMessage, 'role' | 'content' | 'timestamp'>> = {},
): ChatMessage => {
  // The stored id when the command gave one, so a proposal can be settled by it later.
  const message: ChatMessage = { id: uuidv4(), role, content, timestamp: new Date(), ...extra };
  chatMessagesById.value = {
    ...chatMessagesById.value,
    [chatId]: [...(chatMessagesById.value[chatId] ?? []), message],
  };
  const current = chatSummaries.value.find((chat) => chat.id === chatId);
  if (current) {
    const first = current.messageCount === 0 && role === 'user';
    const oneLine = content.trim().replace(/\s+/g, ' ');
    const title = first ? (oneLine.length > 60 ? `${oneLine.slice(0, 59).trimEnd()}…` : oneLine) : current.title;
    chatSummaries.value = sortChats(
      chatSummaries.value.map((chat) => chat.id === chatId ? { ...chat, title, updatedAt: message.timestamp, messageCount: chat.messageCount + 1 } : chat),
    );
  }
  return message;
};

/** Mark a proposal as run or dismissed in the open conversation, as the log now says. */
export const settleChatProposal = (chatId: string, messageId: string, settled: ProposalSettled) => {
  chatMessagesById.value = {
    ...chatMessagesById.value,
    [chatId]: (chatMessagesById.value[chatId] ?? []).map((message) => message.id === messageId ? { ...message, settled } : message),
  };
};

export const setChatLoading = (id: string, loading: boolean, phase?: ChatResponsePhase) => {
  chatLoadingIds.value = loading ? [...new Set([...chatLoadingIds.value, id])] : chatLoadingIds.value.filter((chatId) => chatId !== id);
  if (loading && phase) chatResponsePhases.value = { ...chatResponsePhases.value, [id]: phase };
  if (!loading && Object.hasOwn(chatResponsePhases.value, id)) {
    const { [id]: _finished, ...remaining } = chatResponsePhases.value;
    chatResponsePhases.value = remaining;
  }
  if (!loading && Object.hasOwn(chatLiveTurns.value, id)) {
    const { [id]: _finished, ...remaining } = chatLiveTurns.value;
    chatLiveTurns.value = remaining;
  }
};

/** A sample of the turn in flight; one that lands after the reply is dropped. */
export const setChatLiveTurn = (id: string, live: AssistantLive) => {
  if (!chatLoadingIds.value.includes(id)) return;
  chatResponsePhases.value = { ...chatResponsePhases.value, [id]: live.phase };
  chatLiveTurns.value = { ...chatLiveTurns.value, [id]: live };
};
