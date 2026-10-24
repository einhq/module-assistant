import { assertEquals } from '@std/assert';
import type { Command } from '@ein/client';
import type { AssistantEvent } from '../lib/reply.ts';
import { beginAssistantProgress, finishAssistantProgress, readAssistantProgress, setAssistantDraft, setAssistantProgress, setAssistantTimeline } from '../lib/progress.ts';

const command = (uid: number) => ({ access: { uid } }) as Command;
const id = '12345678-1234-4234-9234-123456789abc';

Deno.test('assistant progress is private to the user and follows the model phase', () => {
  const owner = command(1000);
  const other = command(1001);
  beginAssistantProgress(owner, id);
  assertEquals(readAssistantProgress(owner, id), { phase: 'waiting', timeline: [] });
  assertEquals(readAssistantProgress(other, id), null);
  setAssistantProgress(owner, id, 'thinking');
  assertEquals(readAssistantProgress(owner, id)?.phase, 'thinking');
  finishAssistantProgress(owner, id);
  assertEquals(readAssistantProgress(owner, id), null);
});

Deno.test('assistant progress holds the timeline, the running command and the draft, copied', () => {
  const owner = command(1002);
  beginAssistantProgress(owner, id);
  const timeline: AssistantEvent[] = [{ kind: 'thinking', text: 'Först albumet.', ms: 900 }, { kind: 'command', tool: 'ls', args: { path: '/' }, summary: 'ls /', ms: 5 }];
  setAssistantTimeline(owner, id, timeline, 'search --query båt');
  timeline.push({ kind: 'text', text: 'later' });
  assertEquals(readAssistantProgress(owner, id)?.timeline.map((event) => event.kind), ['thinking', 'command']);
  assertEquals(readAssistantProgress(owner, id)?.running, 'search --query båt');

  setAssistantDraft(owner, id, { reasoning: '', content: '', calls: [{ name: 'final_answer', arguments: '{"answer":"Tv' }] });
  assertEquals(readAssistantProgress(owner, id)?.draft, { reasoning: '', content: '', tool: 'final_answer', args: '{"answer":"Tv' });
  setAssistantDraft(owner, id, null);
  assertEquals(readAssistantProgress(owner, id)?.draft, undefined);
  finishAssistantProgress(owner, id);
});
