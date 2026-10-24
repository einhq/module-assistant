import { assertEquals } from '@std/assert';
import { formatChatTime, formatChatTimestamp } from './chat-time.ts';

Deno.test('chat time uses the Swedish 24-hour clock', () => {
  assertEquals(formatChatTime(new Date(2026, 8, 21, 13, 5)), '13:05');
});

Deno.test('chat time pads midnight with zeroes', () => {
  assertEquals(formatChatTime(new Date(2026, 8, 21, 0, 4)), '00:04');
});

Deno.test('chat timestamp includes the full English date and 24-hour time', () => {
  assertEquals(formatChatTimestamp(new Date(2026, 8, 22, 13, 5)), 'Tuesday, 22 September 2026 at 13:05');
});
