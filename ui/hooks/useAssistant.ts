import { useCallback } from 'react';
import type { AssistantContext } from '@assistant/api';
import { type AssistantLive, type AssistantReply, type CommandResult, proposalScript, replyMediaItems } from '../lib/assistant.ts';
import { lightboxPathFromSearch, shq, uuidv4 } from '@ein/ui/lib';
import {
  activeChatId,
  addChatMessage,
  chatHistory,
  chatLoadingIds,
  type ChatMessage,
  chatShown,
  chatThink,
  guestChat,
  setChatLiveTurn,
  setChatLoading,
  settleChatProposal,
} from '../signals/chat.ts';
import { execCommand, ExecError, execScript, noteOutsideEdit, pageLocation, pageShown } from '@ein/ui/signals';

const PROGRESS_POLL_MS = 400;

/**
 * One question to the assistant, from the drawer.
 *
 * The request names the active VFS chat and what the page is showing — the route, the sidebar
 * entry it is under, the title and node the page declares (`pageShown`), and the picture open in
 * the lightbox. `assistant-ask` reads the earlier turns from that log and appends both sides of
 * this turn. The guest has no log: its conversation goes along as `--history`, and the pictures
 * already shown in the context. The optimistic bubbles keep the UI immediate.
 *
 * The loop takes seconds — several model calls and the commands they ask for. The shell client
 * answers only once with the reply, so while it runs the hook samples the turn's private status:
 * the commands finished and the one running, and the model's call in flight as it streams.
 *
 * A reply never navigates: the page the user is reading stays. The bubble carries its destinations
 * as links ("Show in search", the people, the pictures), and following one is the user's move.
 *
 * A reply may instead carry a proposal — a line the assistant judged to change something.
 * `runProposal` is the confirmation: it runs it here, through `execCommand`, and records how it went in the chat log, where the next turn's history
 * and a reload both find it. Then the turn goes on (`assistant-ask --resume`): the model reads
 * what the line printed — or that it was declined — and takes the next step or answers.
 */
export function useAssistant() {
  /**
   * One turn of `assistant-ask`, watched while it runs: a new question (`args` ends with it), or
   * `--resume`, the last turn going on after its proposal was run or declined.
   */
  const converse = useCallback(async (chatId: string, args: string, think: boolean): Promise<void> => {
    setChatLoading(chatId, true, 'waiting');
    const progressId = uuidv4();
    let stopProgress = false;
    const progressWatcher = (async () => {
      while (!stopProgress) {
        await new Promise((resolve) => setTimeout(resolve, PROGRESS_POLL_MS));
        if (stopProgress) break;
        try {
          const status = await execCommand<AssistantLive | { phase: null }>(`assistant-chat progress ${shq(progressId)}`);
          if (status.phase) setChatLiveTurn(chatId, status);
        } catch {
          // The answer request owns error reporting; a missed status sample is harmless.
        }
      }
    })();

    // The page's, not this router's: the chat is often in the drawer, beside the page it asks about.
    const page = pageLocation();
    const context: AssistantContext = page ? { route: `${page.pathname}${page.search}`, ...pageShown(), lightbox: lightboxPathFromSearch(page.search) } : {};
    const guest = guestChat.value;
    if (guest) context.shown = chatShown(chatId);
    const earlier = guest ? `--history ${shq(JSON.stringify(chatHistory(chatId)))}` : `--chat ${shq(chatId)}`;

    try {
      const reply = await execCommand<AssistantReply>(
        `assistant-ask${think ? ' --think' : ''} ${earlier} --progress ${shq(progressId)} --context ${shq(JSON.stringify(context))} ${args}`,
      );
      addChatMessage(chatId, 'assistant', reply.answer, {
        ...(reply.messageId ? { id: reply.messageId } : {}),
        ...(reply.proposal ? { proposal: reply.proposal } : {}),
        ...(reply.cards ? { cards: reply.cards } : {}),
        ...(reply.table ? { table: reply.table } : {}),
        ...(reply.nodeTypes ? { nodeTypes: reply.nodeTypes } : {}),
        media: replyMediaItems(reply),
        links: reply.links,
        search: reply.search,
        steps: reply.steps,
        ...(reply.timeline ? { timeline: reply.timeline } : {}),
        elapsedMs: reply.elapsedMs,
        timing: reply.timing,
        error: reply.error,
        failure: reply.failure,
      });
    } catch (error) {
      // A failed exec is the transport's failure, not the model's: the command itself
      // answers with an apology rather than exiting non-zero.
      const reason = error instanceof Error ? error.message : String(error);
      addChatMessage(chatId, 'assistant', 'Something went wrong while contacting the assistant.', { error: reason });
    } finally {
      stopProgress = true;
      void progressWatcher;
      setChatLoading(chatId, false);
    }
  }, []);

  const ask = useCallback(async (text: string): Promise<void> => {
    const message = text.trim();
    const chatId = activeChatId.value;
    if (!message || !chatId || chatLoadingIds.value.includes(chatId)) return;
    const think = chatThink.value;
    addChatMessage(chatId, 'user', message, think ? { think } : {});
    await converse(chatId, shq(message), think);
  }, [converse]);

  /** Record a proposal's fate in the log and in the open conversation. */
  const settle = useCallback(
    async (chatId: string, message: ChatMessage, status: 'ran' | 'failed' | 'dismissed', error?: string, results?: CommandResult[], script?: string) => {
      const at = new Date().toISOString();
      const flags = `${error ? ` --error ${shq(error)}` : ''}${results?.length ? ` --results ${shq(JSON.stringify(results))}` : ''}${
        script ? ` --script ${shq(script)}` : ''
      }`;
      try {
        await execCommand(`assistant-chat outcome ${shq(chatId)} ${shq(message.id)} ${status}${flags}`);
      } catch (err) {
        // The change is made (or not) either way; a log that could not be written is worth a line, not a broken card.
        console.warn('assistant-chat outcome failed', err);
      }
      settleChatProposal(chatId, message.id, { status, at, ...(error ? { error } : {}), ...(results?.length ? { results } : {}), ...(script ? { script } : {}) });
    },
    [],
  );

  /**
   * Run a proposal: the card's block, as one script through the shell — as proposed, or as
   * the user rewrote it. The block leads with `set -e`, so a failing line stops the rest, and
   * an edited block is recorded as the script that ran, so the card and the model's history
   * both say what actually happened rather than what was suggested.
   */
  const runProposal = useCallback(async (message: ChatMessage, script?: string): Promise<void> => {
    const chatId = activeChatId.value;
    const proposal = message.proposal;
    if (!chatId || !proposal || message.settled || chatLoadingIds.value.includes(chatId)) return;
    const original = proposalScript(proposal);
    const edited = script !== undefined && script.trim() !== original.trim();
    const source = edited ? script : original;
    if (!source.trim()) return;
    setChatLoading(chatId, true);
    try {
      let failure: string | undefined;
      let result: CommandResult;
      try {
        // As in a terminal: no JSON mode, the text a person would read.
        const output = await execScript(source);
        result = { command: source, ok: true, exitCode: 0, output: output.slice(0, 4000) };
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        // stdout up to the failure, then stderr — the terminal's order, near enough.
        const stdout = error instanceof ExecError && error.output ? error.output : '';
        const stderr = error instanceof ExecError ? error.stderr ?? failure : failure;
        result = {
          command: source,
          ok: false,
          ...(error instanceof ExecError && error.exitCode !== undefined ? { exitCode: error.exitCode } : {}),
          output: `${stdout}${stdout && !stdout.endsWith('\n') ? '\n' : ''}${stderr}`.slice(0, 4000),
        };
      }
      // A line may have run before a later one failed: the page still has to re-read.
      noteOutsideEdit();
      await settle(chatId, message, failure ? 'failed' : 'ran', failure, [result], edited ? script : undefined);
    } finally {
      setChatLoading(chatId, false);
    }
    // The assistant reads what the change printed and goes on: the next step, or the answer.
    await converse(chatId, '--resume', chatThink.value);
  }, [settle, converse]);

  const dismissProposal = useCallback(async (message: ChatMessage): Promise<void> => {
    const chatId = activeChatId.value;
    if (!chatId || !message.proposal || message.settled || chatLoadingIds.value.includes(chatId)) return;
    await settle(chatId, message, 'dismissed');
    // Told it was declined, the assistant can say what it will do instead.
    await converse(chatId, '--resume', chatThink.value);
  }, [settle, converse]);

  return { ask, runProposal, dismissProposal };
}
