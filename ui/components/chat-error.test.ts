import { assertEquals } from '@std/assert';
import { ASSISTANT_ERROR_MESSAGE, ASSISTANT_NO_ANSWER_MESSAGE, ASSISTANT_TOO_LONG_MESSAGE, errorCardFor, retryTextFor } from './chat-error.ts';

Deno.test('the assistant error message is English only', () => {
  assertEquals(ASSISTANT_ERROR_MESSAGE, 'The assistant is not available right now.');
});

Deno.test('a model that gave up is not called unavailable', () => {
  assertEquals(errorCardFor('no-answer'), { title: 'No answer', text: ASSISTANT_NO_ANSWER_MESSAGE });
  assertEquals(errorCardFor('unavailable'), { title: 'Assistant unavailable', text: ASSISTANT_ERROR_MESSAGE });
  assertEquals(errorCardFor('too-long'), { title: 'Answer too long', text: ASSISTANT_TOO_LONG_MESSAGE });
  // A transport failure, or a turn stored without a kind.
  assertEquals(errorCardFor(undefined).title, 'Assistant unavailable');
});

Deno.test('an assistant error retries the preceding user question', () => {
  const messages = [
    { role: 'user' as const, content: "Who are Olof Strand's family?" },
    { role: 'assistant' as const, content: 'The assistant is not available right now.' },
  ];

  assertEquals(retryTextFor(messages, 1), "Who are Olof Strand's family?");
});

Deno.test('retry uses the latest user question in restored history', () => {
  const messages = [
    { role: 'user' as const, content: 'First question' },
    { role: 'assistant' as const, content: 'First answer' },
    { role: 'user' as const, content: '  Second question  ' },
    { role: 'assistant' as const, content: 'The assistant is not available right now.' },
  ];

  assertEquals(retryTextFor(messages, 3), 'Second question');
  assertEquals(retryTextFor(messages, 0), undefined);
});
