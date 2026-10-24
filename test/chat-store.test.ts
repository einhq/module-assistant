import { assertEquals, assertMatch } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, type ShellClient } from '@ein/testing';
import type { AssistantReply } from '../lib/reply.ts';
import { startStubLlm } from './stub-llm.ts';

type WireSummary = { id: string; title: string; createdAt: string; updatedAt: string; messageCount: number };
type WireMessage = { id: string; role: 'user' | 'assistant'; content: string; timestamp: string };

const testCtx = createTestContext({ modules: ['assistant'], boot: true });
let client: ShellClient;

const shq = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

Deno.test({
  name: 'assistant chats persist as private per-user VFS logs',
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { vfs } = await testCtx.setup();
  client = await testCtx.server.createShellClient();
  const model = startStubLlm(() => ({ tool: 'final_answer', args: { answer: 'A durable answer' } }));

  try {
    const initial = await client.execJson<{ chats: WireSummary[] }>('assistant-chat list');
    assertEquals(initial.chats, []);

    const created = await client.execJson<{ chat: WireSummary }>('assistant-chat create');
    assertMatch(created.chat.id, /^[0-9a-f-]{36}$/);
    assertEquals(created.chat.title, 'New chat');
    assertEquals(created.chat.messageCount, 0);

    const directory = await vfs.get(ADMIN_ACCESS, '/home/admin/.chats');
    const log = await vfs.get(ADMIN_ACCESS, `/home/admin/.chats/${created.chat.id}`);
    assertEquals(directory.type, 'directory');
    assertEquals(directory.props.mode, 0o700);
    assertEquals(log.type, 'log');
    assertEquals(log.props.mode, 0o600);
    assertEquals(log.attrs.retention, 'forever');

    const reply = await client.execJson<AssistantReply>(
      `CFG_LLM_URL=${model.url} assistant-ask --chat ${shq(created.chat.id)} --context '{}' ${shq('What happened on the boat?')}`,
    );
    assertEquals(reply.answer, 'A durable answer');

    const read = await client.execJson<{ chat: WireSummary; messages: WireMessage[] }>(`assistant-chat read ${created.chat.id}`);
    assertEquals(read.chat.title, 'What happened on the boat?');
    assertEquals(read.chat.messageCount, 2);
    assertEquals(read.messages.map(({ role, content }) => ({ role, content })), [
      { role: 'user', content: 'What happened on the boat?' },
      { role: 'assistant', content: 'A durable answer' },
    ]);
    assertEquals(read.messages.every((message) => !Number.isNaN(Date.parse(message.timestamp))), true);

    const listed = await client.execJson<{ chats: WireSummary[] }>('assistant-chat list');
    assertEquals(listed.chats.map(({ id, title, messageCount }) => ({ id, title, messageCount })), [
      { id: created.chat.id, title: 'What happened on the boat?', messageCount: 2 },
    ]);

    await client.execJson(`assistant-chat delete ${created.chat.id}`);
    assertEquals((await client.execJson<{ chats: WireSummary[] }>('assistant-chat list')).chats, []);
  } finally {
    await model.close();
    await client.close();
    await testCtx.teardown();
  }
});

Deno.test({
  name: 'a user whose home is in a group they are not in can open their chats',
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { vfs } = await testCtx.setup();
  const admin = await testCtx.server.createShellClient();
  const clients: ShellClient[] = [admin];
  try {
    await admin.execJson('group-create elsewhere --gid 4100');
    await admin.execJson('user-create anna --uid 4000');
    await admin.execJson('user-passwd anna --new-password secret');
    await admin.execJson('chown anna:elsewhere /home/anna');
    const anna = await testCtx.server.createShellClient({ username: 'anna', password: 'secret' });
    clients.push(anna);

    assertEquals((await anna.execJson<{ chats: WireSummary[] }>('assistant-chat list')).chats, []);
    const created = await anna.execJson<{ chat: WireSummary }>('assistant-chat create');
    assertEquals(created.chat.messageCount, 0);
    const directory = await vfs.get(ADMIN_ACCESS, '/home/anna/.chats');
    assertEquals([directory.props.uid, directory.props.gid, directory.props.mode], [4000, 4000, 0o700]);
  } finally {
    for (const client of clients) await client.close();
    await testCtx.teardown();
  }
});
