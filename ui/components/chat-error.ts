import type { AssistantFailure } from '../lib/assistant.ts';

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** The error card's text, whatever the stored turn's own text says. */
export const ASSISTANT_ERROR_MESSAGE = 'The assistant is not available right now.';
export const ASSISTANT_NO_ANSWER_MESSAGE = 'The assistant could not answer this question.';
export const ASSISTANT_TOO_LONG_MESSAGE = 'The answer was too long to finish. Ask for less, such as the last 20 rows.';

/**
 * The error card's words. Only a model that gave up on the question says so; anything else —
 * the service down, the request lost, a turn stored without a kind — is "unavailable".
 */
export function errorCardFor(failure: AssistantFailure | undefined): { title: string; text: string } {
  if (failure === 'no-answer') return { title: 'No answer', text: ASSISTANT_NO_ANSWER_MESSAGE };
  if (failure === 'too-long') return { title: 'Answer too long', text: ASSISTANT_TOO_LONG_MESSAGE };
  return { title: 'Assistant unavailable', text: ASSISTANT_ERROR_MESSAGE };
}

/** The failed assistant turn retries the user question immediately before it. */
export function retryTextFor(messages: ConversationMessage[], errorIndex: number): string | undefined {
  for (let index = errorIndex - 1; index >= 0; index--) {
    if (messages[index].role === 'user') {
      const text = messages[index].content.trim();
      return text || undefined;
    }
  }
  return undefined;
}
