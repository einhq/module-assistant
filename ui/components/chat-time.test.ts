import { assertEquals } from '@std/assert';
import { formatChatTime, formatChatTimestamp } from './chat-time.ts';

Deno.test('chat time is the hour and minute, on the default 24-hour clock', () => {
  assertEquals(formatChatTime(new Date(2026, 8, 21, 13, 5)), '13:05');
});

Deno.test('chat time pads midnight with zeroes', () => {
  assertEquals(formatChatTime(new Date(2026, 8, 21, 0, 4)), '00:04');
});

Deno.test('chat timestamp includes the full date and the time', () => {
  assertEquals(formatChatTimestamp(new Date(2026, 8, 22, 13, 5)), 'tisdag 22 september 2026 kl. 13:05');
});
