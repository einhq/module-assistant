/**
 * `assistant-ask` end to end on the commands loop, with a scripted model.
 *
 * A stub OpenAI-compatible model service (`stub-llm.ts`) answers with what the script says next —
 * a reply, or a tool call the way the API returns one — so every leg runs for real: the prompt file,
 * the tools from the commands' own specs, the command lines run against real nodes, the results fed
 * back, the reply the drawer draws. Only the model's judgement is scripted. The cache contract is
 * checked on what the service is sent: a second turn whose conversation begins with exactly what
 * the first one sent.
 *
 * Nothing but core and the assistant is installed: a module of the test's own offers its commands,
 * cards and words through a drop-in, as any module does.
 */

import { assert, assertEquals, assertMatch, assertRejects, assertStringIncludes } from '@std/assert';
import { ADMIN_ACCESS, captureTime, createTestContext, type ShellClient, testCommands } from '@ein/testing';
import type { AssistantReply } from '../lib/reply.ts';
import type { SearchParse } from '@ein/api';
import { startStubLlm, type StubMessage, type StubReply, type StubRequest, stubTokens } from './stub-llm.ts';
import { shortened } from '../lib/context.ts';
import type { LlmMessage } from '../lib/llm.ts';

const testCtx = createTestContext({ modules: ['assistant'], boot: true });
let client: ShellClient;

type Message = StubMessage;
type Request = StubRequest;
/** Given the conversation so far, what the model says next. */
type Script = (last: Message, messages: Message[]) => StubReply;

/** A tool call, sent back as the API sends one. */
const tool = (name: string, args: Record<string, unknown> = {}): StubReply => ({ tool: name, args });

const shq = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const PEOPLE = '/test/people';
const ANNA = `${PEOPLE}/Anna_Exempel`;
const BO = `${PEOPLE}/Bo_Exempel`;
const CECILIA = `${PEOPLE}/Cecilia_Exempel`;
const ALBUM = '/test/albums/Exempelalbum_2019';
/** The summer's pictures, IMG_0001 and IMG_0002: a search the model runs. */
const SUMMER = { under: `${ALBUM}/files`, kind: 'photo', from: '2019-07', to: '2019-08' };

Deno.test({
  name: 'assistant-ask',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  client = await testCtx.server.createShellClient();
  let cmd = testCommands(client);
  const writeFile = async (path: string, text: string) => {
    const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'w' });
    try {
      await handle.write(new TextEncoder().encode(text));
    } finally {
      await handle.close();
    }
  };
  const NOTHING_READ: SearchParse = { text: '', kinds: [], subjects: [], unresolved: [], source: 'none', explain: '' };
  /** What the fake search parser answers next. */
  const parseAs = async (parse: SearchParse) => {
    // Made once; a second mkfile fails, and is not needed.
    await client.exec('mkfile /tmp/fake-parse.json');
    await writeFile('/tmp/fake-parse.json', JSON.stringify(parse));
  };

  /** Run one turn against a scripted model; the reply, and every request the model service was sent. */
  const askWith = async (script: Script, args: string, env = '', stub: Parameters<typeof startStubLlm>[1] = {}): Promise<{ reply: AssistantReply; asked: Request[] }> => {
    const model = startStubLlm((request) => script(request.messages[request.messages.length - 1], request.messages), stub);
    try {
      const reply = await client.execJson<AssistantReply>(`${env}CFG_LLM_URL=${model.url} assistant-ask ${args}`);
      return { reply, asked: model.requests };
    } finally {
      await model.close();
    }
  };

  /** The name of the tool whose result the model has just been handed, found by the call it answers. */
  const after = (last: Message, messages: Message[]) =>
    last.role !== 'tool' ? undefined : messages.flatMap((m) => m.tool_calls ?? []).find((c) => c.id === last.tool_call_id)?.function.name;

  try {
    for (const [path, name] of [[ANNA, 'Anna Exempel'], [BO, 'Bo Exempel'], [CECILIA, 'Cecilia Exempel']]) {
      await cmd.shouldSucceed(`mkdir -p ${path}`);
      await cmd.shouldSucceed(`attrs ${path} -s name=${shq(name)}`);
    }
    await cmd.shouldSucceed(`mkdir -p ${ALBUM}/files`);
    for (const [name, takenAt] of [['IMG_0001.jpg', '2019-07-12T10:00:00'], ['IMG_0002.jpg', '2019-08-01T10:00:00'], ['IMG_0003.jpg', '2019-09-01T10:00:00']]) {
      const path = `${ALBUM}/files/${name}`;
      await cmd.shouldSucceed(`echo x > ${path}`);
      await vfs.update(ADMIN_ACCESS, path, { attrs: { mimetype: 'image/jpeg', width: 400, height: 300, ...captureTime(takenAt) } });
    }
    // Cards of a module of the test's own: one around a person, one that pins the answer's pictures.
    const testCards = [
      {
        name: 'tree',
        route: '/test/tree',
        description: 'A tree around a person.',
        params: {
          type: 'object',
          properties: { person: { type: 'string', format: 'path' }, people: { type: 'array', items: { type: 'string', format: 'path' } } },
          required: ['person'],
        },
      },
      {
        name: 'pins',
        route: '/test/pins',
        description: 'Pins on a map.',
        params: { type: 'object', properties: { title: { type: 'string' }, paths: { type: 'array', items: { type: 'string', format: 'path' } } } },
        fill: { paths: 'pictures' },
      },
    ];
    await cmd.shouldSucceed(`mkdir -p /etc/assistant.d/test && echo ${shq(JSON.stringify(testCards))} > /etc/assistant.d/test/cards.json`);
    await cmd.shouldSucceed(`echo 'THE TEST MODULE: what it keeps.' > /etc/assistant.d/test/prompt.md`);
    await cmd.shouldSucceed(`printf 'search\\nfind\\n# a write, which is proposed\\nrm\\n' > /etc/assistant.d/test/tools`);
    // A search parser that reads every search as the step says (`parseAs`), and by default finds
    // nothing to read, so a request for pictures goes to the loop. Set as the administrator's
    // setting, which wins over a module's.
    await cmd.shouldSucceed('mkdir -p /opt/bin && mkfile /opt/bin/fake-parse && chmod 755 /opt/bin/fake-parse');
    await writeFile('/opt/bin/fake-parse', 'cat /tmp/fake-parse.json\n');
    await cmd.shouldSucceed(`echo 'export PATH="$PATH:/opt/bin"' >> /etc/bashrc`);
    await cmd.shouldSucceed(`echo "export CFG_SEARCH_PARSER='fake-parse'" >> /etc/config`);
    await parseAs(NOTHING_READ);
    client.close();
    client = await testCtx.server.createShellClient();
    cmd = testCommands(client);
    const prompt = `${(await client.exec('cat /etc/assistant-prompt.md')).data}`.trim();
    const chat = (await client.execJson<{ chat: { id: string } }>('assistant-chat create')).chat.id;
    let firstTurn: Request[] = [];

    await t.step('a name, its path, its pictures: the commands run, the last search is what is shown', async () => {
      const script: Script = (last, messages) => {
        if (last.role === 'user') return tool('find', { path: PEOPLE, name: 'Anna*' });
        if (after(last, messages) === 'find') return tool('search', SUMMER);
        return tool('final_answer', { answer: 'Här är bilderna där Anna är med.', links: [ANNA] });
      };
      const { reply, asked } = await askWith(script, `--chat ${chat} ${shq('Vilka bilder finns där Anna Exempel är med?')}`);
      firstTurn = asked;
      assertEquals(reply.error, undefined);
      assertEquals(reply.answer, 'Här är bilderna där Anna är med.');
      assertEquals(reply.media.map((hit) => hit.path).sort(), [`${ALBUM}/files/IMG_0001.jpg`, `${ALBUM}/files/IMG_0002.jpg`]);
      assertEquals(reply.links, [{ label: 'Anna Exempel', path: ANNA, type: 'directory' }]);
      assertEquals(reply.search, { kinds: ['photo'], fromYear: 2019, toYear: 2019 });
      assertEquals(reply.steps.map((step) => step.tool), ['find', 'search']);

      // What the model service was sent: the commands as tools, described by their own specs.
      assertEquals(asked.length, 3);
      for (const request of asked) assertEquals(request.model, 'qwen3.5-4b');
      const names = asked[0].tools!.map((schema) => schema.function.name);
      // The assistant's own (ls), the test module's (search, rm), and the way to every other.
      for (const name of ['ls', 'cat', 'search', 'find', 'rm', 'run_command', 'final_answer']) assert(names.includes(name), name);
      assert(asked[0].messages[0].content!.startsWith(prompt), 'the system message starts with the prompt file');
      assert(!/\d{4}-\d{2}-\d{2}/.test(asked[0].messages[0].content!.slice(prompt.length)), 'and carries no date');
      assertMatch(asked[0].messages[1].content!, /^\[\w{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}\] Vilka bilder finns där Anna Exempel är med\?$/);
      // Each call extends the last: the model's call, then the command's result answering it by id.
      assertEquals(asked[1].messages.slice(0, asked[0].messages.length), asked[0].messages);
      assertEquals(asked[1].messages.slice(-2).map((m) => m.role), ['assistant', 'tool']);
      assertEquals(asked[1].messages.at(-1)!.tool_call_id, asked[1].messages.at(-2)!.tool_calls![0].id);
    });

    await t.step('the next turn sends the first one back, a long result shortened, so the session can continue', async () => {
      const { reply, asked } = await askWith(() => tool('final_answer', { answer: 'Bo är Annas pappa.' }), `--chat ${chat} ${shq('Och vem är Bo?')}`);
      assertEquals(reply.answer, 'Bo är Annas pappa.');
      const before = firstTurn[firstTurn.length - 1].messages;
      const now = asked[0].messages;
      assertEquals(now.slice(0, before.length), before.map((message) => shortened(message as LlmMessage)));
      assert(now.slice(0, before.length).some((message, i) => message.content !== before[i].content), 'the search result is shortened');
      // Then the model's answer as it gave it, its result (the API wants one for every call), then
      // the new question with its own time.
      assertEquals(now[before.length].tool_calls?.[0].function.name, 'final_answer');
      assertEquals(now[before.length + 1].tool_call_id, now[before.length].tool_calls?.[0].id);
      assertEquals(now.length, before.length + 3);
      assertMatch(now[now.length - 1].content!, /^\[.*\] Och vem är Bo\?$/);
    });

    await t.step('the chat keeps what the model read before it, and every answer names its checksum', async () => {
      const node = await vfs.get(ADMIN_ACCESS, `/home/admin/.chats/${chat}`);
      const context = node.attrs.chatModelContext as { checksum: string; system: string; tools: { function: { name: string } }[]; since: string };
      assert(context.system.startsWith(prompt), 'the system message as sent');
      // What each module says of its part follows the file, before what is true of the asker.
      const module = context.system.indexOf('THE TEST MODULE: what it keeps.');
      assert(module > prompt.length && module < context.system.indexOf('CONTEXT:'), "a module's text after the file");
      assert(context.tools.some((tool) => tool.function.name === 'find'), 'the tools as sent');
      const read = await client.execJson<{ messages: { role: string; contextChecksum?: string }[] }>(`assistant-chat read ${chat}`);
      const answers = read.messages.filter((m) => m.role === 'assistant');
      assertEquals(answers.map((m) => m.contextChecksum), [context.checksum, context.checksum]);
      // The second turn changed nothing, so the record is the first turn's.
      const since = context.since;
      await askWith(() => tool('final_answer', { answer: 'ok' }), `--chat ${chat} ${shq('tack')}`);
      assertEquals(((await vfs.get(ADMIN_ACCESS, `/home/admin/.chats/${chat}`)).attrs.chatModelContext as { since: string }).since, since);
    });

    await t.step('an edited prompt reaches an open chat at its next turn, at the top', async () => {
      const before = (await vfs.get(ADMIN_ACCESS, `/home/admin/.chats/${chat}`)).attrs.chatModelContext as { checksum: string };
      await cmd.shouldSucceed(`echo 'Svara alltid kort.' >> /etc/assistant-prompt.md`);
      try {
        const { asked } = await askWith(() => tool('final_answer', { answer: 'ok' }), `--chat ${chat} ${shq('en fråga till')}`);
        // Where the model was trained to read it: the system message, not a note further down.
        assertStringIncludes(asked[0].messages[0].content!, 'Svara alltid kort.');
        assertEquals(asked[0].messages.filter((m) => m.content?.includes('Svara alltid kort.')).length, 1);
        const after = (await vfs.get(ADMIN_ACCESS, `/home/admin/.chats/${chat}`)).attrs.chatModelContext as { checksum: string; system: string };
        assert(after.checksum !== before.checksum, 'a new checksum on record');
        assertStringIncludes(after.system, 'Svara alltid kort.');
        const read = await client.execJson<{ messages: { role: string; contextChecksum?: string }[] }>(`assistant-chat read ${chat}`);
        assertEquals(read.messages.filter((m) => m.role === 'assistant').at(-1)?.contextChecksum, after.checksum);
      } finally {
        await client.exec(`echo ${shq(prompt)} > /etc/assistant-prompt.md`);
      }
    });

    await t.step('a picture on screen is in the message, not in the system text', async () => {
      const shown = `${ALBUM}/files/IMG_0003.jpg`;
      const { asked } = await askWith(() => tool('final_answer', { answer: 'ok' }), `--context ${shq(JSON.stringify({ lightbox: shown }))} ${shq('vem är det här?')}`);
      assertStringIncludes(asked[0].messages[1].content!, `open picture ${shown}`);
      assert(!asked[0].messages[0].content!.includes(shown));
    });

    await t.step('the page on screen is in the message by name, what it shows and node', async () => {
      const context = { route: '/albums/A', section: 'Albums', title: 'Sommar', about: 'Tre bilder', node: ALBUM };
      const { asked } = await askWith(() => tool('final_answer', { answer: 'ok' }), `--context ${shq(JSON.stringify(context))} ${shq('vad är det här för sida?')}`);
      assertStringIncludes(asked[0].messages[1].content!, `on screen: Albums › Sommar, "Tre bilder", about node ${ALBUM}`);
      const { asked: unpathed } = await askWith(
        () => tool('final_answer', { answer: 'ok' }),
        `--context ${shq(JSON.stringify({ route: '/x', node: 'x' }))} ${shq('och nu?')}`,
      );
      assert(!unpathed[0].messages[1].content!.includes('node x'), 'a node that is not a path is left out');
    });

    await t.step('a page whose name is one of several says which one is on screen', async () => {
      const context = { route: '/staging?c=box-3', section: 'Staging', title: 'Box 3', about: 'New media to sort' };
      const { asked } = await askWith(() => tool('final_answer', { answer: 'ok' }), `--context ${shq(JSON.stringify(context))} ${shq('vilken kategori?')}`);
      assertStringIncludes(asked[0].messages[1].content!, 'on screen: Staging › Box 3, "New media to sort", ?c=box-3');
    });

    await t.step("the cards the modules offer are final_answer's properties, as the modules describe them", async () => {
      const script: Script = () => tool('final_answer', { answer: 'Hej.' });
      const { asked } = await askWith(script, shq('hej'));
      type Schema = { properties: Record<string, { description?: string; properties?: Record<string, unknown>; required?: string[] }> };
      const finalAnswer = (asked[0].tools ?? []).find((entry) => entry.function.name === 'final_answer')!.function as unknown as { parameters: Schema };
      const { chart, tree, pins } = finalAnswer.parameters.properties;
      assertStringIncludes(chart.description!, 'chart');
      assertEquals(tree.description, 'A tree around a person.');
      assertEquals(tree.required, ['person']);
      assertEquals(Object.keys(pins.properties!), ['title', 'paths']);
    });

    await t.step('what is in a directory is an ls', async () => {
      const script: Script = (last) => last.role === 'user' ? tool('ls', { path: `${ALBUM}/files`, l: true }) : tool('final_answer', { answer: 'Tre bilder.' });
      const { reply, asked } = await askWith(script, shq('vad finns i albumets filkatalog'));
      assertEquals(reply.steps.map((step) => step.tool), ['ls']);
      assertStringIncludes(asked[1].messages[asked[1].messages.length - 1].content!, 'IMG_0002.jpg');
    });

    await t.step('a plain request for pictures is the fast path: the search parse, one search, no loop', async () => {
      await parseAs({ text: '', kinds: ['photo'], from: '2019', to: '2019', subjects: [], unresolved: [], source: 'llm', explain: 'bilder från 2019' });
      const script: Script = () => tool('final_answer', { answer: 'the loop' });
      const { reply, asked } = await askWith(script, shq('Visa bilder från 2019'));
      assertEquals(reply.model, 'fast-path');
      assertEquals(asked.length, 0);
      assertEquals(reply.steps.map((step) => step.tool), ['parse-search', 'search']);
      assertEquals(reply.search, { kinds: ['photo'], fromYear: 2019, toYear: 2019, sort: '-time' });
      assertEquals(reply.media.map((hit) => hit.path).sort(), ['IMG_0001.jpg', 'IMG_0002.jpg', 'IMG_0003.jpg'].map((name) => `${ALBUM}/files/${name}`));
      // The parse's own account says what the pictures are.
      assertEquals(reply.answer, 'Här är 3 bilder från 2019.');
    });

    await t.step('a parse that is not sure of a name steps aside for the loop', async () => {
      await parseAs({ text: '', kinds: [], subjects: [], unresolved: ['Anna Exempelsson'], source: 'llm', explain: 'everything' });
      const script: Script = () => tool('final_answer', { answer: 'the loop' });
      const { reply } = await askWith(script, shq('Visa bilder på Anna Exempelsson'));
      assertEquals(reply.answer, 'the loop');
      await parseAs(NOTHING_READ);
    });

    await t.step('what a log holds is a cat, with each entry after its time', async () => {
      const weight = `${ANNA}/measurements/weight`;
      await cmd.shouldSucceed(`mknode -p -t log ${weight}`);
      await cmd.shouldSucceed(`log-append ${weight} --data '{"value":83.4}' --at 2016-09-04T16:13:27.739Z`);
      await cmd.shouldSucceed(`log-append ${weight} --data '{"value":82.4}' --at 2016-09-11T08:00:00.000Z`);
      const script: Script = (last) => last.role === 'user' ? tool('cat', { path: weight, timestamps: true }) : tool('final_answer', { answer: '| Datum | Vikt |' });
      const { reply, asked } = await askWith(script, shq('visa Annas vikt som en tabell'));
      assertEquals(reply.steps.map((step) => [step.tool, (step as { verdict?: string }).verdict]), [['cat', 'ran']]);
      assertStringIncludes(asked[1].messages.at(-1)!.content!, '2016-09-04T16:13:27.739Z\t{"value":83.4}\n2016-09-11T08:00:00.000Z\t{"value":82.4}');
    });

    await t.step('a table is the rows its line prints, read by the code and stored with the message, and the reply keeps none', async () => {
      const weight = `${ANNA}/measurements/weight`;
      const line = `cat -t ${weight}`;
      const script: Script = () => tool('final_answer', { answer: 'Här är Annas vikt.\n- 2016-09-04: 83.1', table: { command: line, title: 'Vikt' } });
      const { reply } = await askWith(script, `--chat ${chat} ${shq('visa Annas vikt som en tabell')}`);
      assertEquals(reply.answer, 'Här är Annas vikt.');
      assertEquals(reply.table, { line, title: 'Vikt', columns: ['time', 'value'], rows: [['2016-09-04 16:13:27', '83.4'], ['2016-09-11 08:00:00', '82.4']] });
      assertEquals(reply.steps.map((step) => [step.tool, (step as { verdict?: string }).verdict]), [['table', 'ran']]);
      const stored = (await client.execJson<{ messages: { table?: unknown }[] }>(`assistant-chat read ${chat}`)).messages.at(-1)!;
      assertEquals(stored.table, reply.table);
    });

    await t.step('a table of a line the turn ran already is not run again', async () => {
      const line = `cat -t ${ANNA}/measurements/weight | tail -n 1`;
      const script: Script = (last) =>
        last.role === 'user' ? tool('run_command', { command: line }) : tool('final_answer', { answer: 'Den senaste.', table: { command: `${line}  ` } });
      const { reply } = await askWith(script, shq('min senaste vikt i en tabell'));
      assertEquals(reply.table?.rows, [['2016-09-11 08:00:00', '82.4']]);
      assertEquals(reply.steps.map((step) => step.tool), ['run_command']);
    });

    await t.step('a long text result says under it how to show it as a table', async () => {
      const steps = `${ANNA}/measurements/steps`;
      await cmd.shouldSucceed(`mknode -p -t log ${steps}`);
      await cmd.shouldSucceed(`for i in $(seq 10 29); do log-append ${steps} --data "{\\"value\\":$i}" --at 2016-09-$i\\T08:00:00.000Z; done`);
      const line = `cat -t ${steps}`;
      const script: Script = (last) => last.role === 'user' ? tool('run_command', { command: line }) : tool('final_answer', { answer: 'Stegen.' });
      const { asked } = await askWith(script, shq('visa mina steg'));
      assertStringIncludes(asked[1].messages.at(-1)!.content!, `(20 lines. To show them as a table: final_answer with table {"command": "${line}"}`);
      const short: Script = (last) => last.role === 'user' ? tool('run_command', { command: `${line} | tail -n 2` }) : tool('final_answer', { answer: 'Två.' });
      assertEquals((await askWith(short, shq('visa två steg'))).asked[1].messages.at(-1)!.content!.includes('as a table'), false);
    });

    await t.step('a line into text tools counts in text, one command or a line into jq answers in JSON', async () => {
      const names = await client.execJson<string[]>(`ls ${ALBUM}/files`);
      const handed = async (line: string) => {
        const script: Script = (last) => last.role === 'user' ? tool('run_command', { command: line }) : tool('final_answer', { answer: '-' });
        return (await askWith(script, shq('hur många bilder finns det'))).asked[1].messages.at(-1)!.content!;
      };
      assertStringIncludes(await handed(`ls ${ALBUM}/files | wc -l`), String(names.length));
      assertStringIncludes(await handed(`echo $(ls ${ALBUM}/files)`), names.join(' '));
      assertStringIncludes(await handed(`ls ${ALBUM}/files | jq length`), String(names.length));
      assertStringIncludes(await handed(`ls ${ALBUM}/files`), JSON.stringify(names));
    });

    await t.step('a long JSON list says how to show it as a table, and a reply that lists it anyway is given it', async () => {
      const names = Array.from({ length: 20 }, (_, i) => `etikett${i + 1}`);
      await cmd.shouldSucceed(`label add ${ALBUM}/files/IMG_0001.jpg ${names.join(' ')}`);
      const listed = `Etiketterna:\n${names.map((name) => `- ${name}: 1`).join('\n')}`;
      const script: Script = (last) => last.role === 'user' ? tool('run_command', { command: 'labels' }) : tool('final_answer', { answer: listed });
      const { reply, asked } = await askWith(script, shq('vilka etiketter finns'));
      assertStringIncludes(asked[1].messages.at(-1)!.content!, '(20 rows. To show them as a table: final_answer with table {"command": "labels"}');
      assertEquals(reply.answer, 'Etiketterna:');
      assertEquals(reply.table?.rows.length, 20);
      // Cut at the token limit while copying them: the table still, with no words of the cut reply.
      const cut: Script = (last) => last.role === 'user' ? tool('run_command', { command: 'labels' }) : { tool: 'final_answer', args: { answer: listed }, cut: true };
      const cutReply = (await askWith(cut, shq('vilka etiketter finns'))).reply;
      assertEquals([cutReply.failure, cutReply.answer, cutReply.table?.rows.length], [undefined, '', 20]);
      await cmd.shouldSucceed(`label remove ${ALBUM}/files/IMG_0001.jpg ${names.join(' ')}`);
    });

    await t.step('a table of a line that writes is refused once, and the answer goes without it', async () => {
      const script: Script = (_, messages) =>
        messages.some((message) => message.role === 'tool')
          ? tool('final_answer', { answer: 'Utan tabell.' })
          : tool('final_answer', { answer: 'Tabell.', table: { command: `rm ${ALBUM}/files/IMG_0001.jpg` } });
      const { reply, asked } = await askWith(script, shq('ta bort och visa'));
      assertEquals(reply.answer, 'Utan tabell.');
      assertEquals(reply.table, undefined);
      assertStringIncludes(asked[1].messages.at(-1)!.content!, 'not shown');
      await cmd.shouldSucceed(`stat ${ALBUM}/files/IMG_0001.jpg`);
    });

    await t.step('a card is its route with the query the model gave, and is stored with the message', async () => {
      // A search on the way to the chart: its pictures are not the answer's.
      const points = [{ label: 'Ja', value: 3 }, { label: 'Nej', value: 5 }];
      const script: Script = (last) =>
        last.role === 'user' ? tool('search', SUMMER) : tool('final_answer', { answer: 'Så här.', chart: { kind: 'pie', title: 'Svar', points } });
      const { reply } = await askWith(script, `--chat ${chat} ${shq('rita 3 ja och 5 nej som en paj')}`);
      assertEquals(reply.cards, [{ id: 'assistant.chart', route: `/chart?${new URLSearchParams({ kind: 'pie', title: 'Svar', points: JSON.stringify(points) })}` }]);
      assertEquals(reply.media, []);
      // Stored with the message, so the chat draws it again when reopened.
      const stored = (await client.execJson<{ messages: { cards?: unknown }[] }>(`assistant-chat read ${chat}`)).messages.at(-1)!;
      assertEquals(stored.cards, reply.cards);
    });

    await t.step('a path the asker cannot see is left out of a card, and a card left without what it needs is none', async () => {
      const nobody = `${PEOPLE}/Nobody_Exempel`;
      const script: Script = () => tool('final_answer', { answer: 'Familjen.', tree: { person: ANNA, people: [BO, nobody] }, chart: { source: `${ANNA}/measurements/none` } });
      const { reply } = await askWith(script, shq('visa Annas familj'));
      assertEquals(reply.cards, [{ id: 'test.tree', route: `/test/tree?${new URLSearchParams([['person', ANNA], ['people', BO]])}` }]);
      const missing: Script = () => tool('final_answer', { answer: 'Familjen.', tree: { person: nobody, people: [BO] } });
      assertEquals((await askWith(missing, shq('visa familjen'))).reply.cards, undefined);
    });

    await t.step('a card that takes the pictures is given those the answer shows, when the model names none', async () => {
      const photos = [`${ALBUM}/files/IMG_0001.jpg`, `${ALBUM}/files/IMG_0002.jpg`];
      const shown: Script = (last) => last.role === 'user' ? tool('search', SUMMER) : tool('final_answer', { answer: 'Här togs de.', pins: {} });
      const { reply } = await askWith(shown, shq('var togs bilderna på Anna?'));
      assertEquals(reply.media.map((hit) => hit.path).sort(), photos);
      const pinned = new URL(reply.cards![0].route, 'http://x').searchParams.getAll('paths');
      assertEquals(pinned.sort(), photos);
      // Named nothing and shown nothing, it is no card.
      const nothing: Script = () => tool('final_answer', { answer: 'Vet inte.', pins: {} });
      assertEquals((await askWith(nothing, shq('var?'))).reply.cards, undefined);
    });

    await t.step('cat without a path is an error result, not a read of stdin', async () => {
      const script: Script = (last) => last.role === 'user' ? tool('cat', {}) : tool('final_answer', { answer: 'Vilken fil?' });
      const { reply, asked } = await askWith(script, shq('visa filen'));
      assertEquals(reply.answer, 'Vilken fil?');
      assertStringIncludes(asked[1].messages.at(-1)!.content!, 'cat takes the absolute path');
    });

    await t.step('cat on a queue is refused before it can take a message', async () => {
      await cmd.shouldSucceed('mknode -p -t queue /tmp/assistant-q');
      await cmd.shouldSucceed(`echo '{"n":1}' > /tmp/assistant-q`);
      const script: Script = (last) => last.role === 'user' ? tool('cat', { path: '/tmp/assistant-q' }) : tool('final_answer', { answer: 'En kö.' });
      const { reply, asked } = await askWith(script, shq('vad ligger i kön'));
      assertEquals(reply.steps.map((step) => (step as { verdict?: string }).verdict), ['failed']);
      assertStringIncludes(asked[1].messages.at(-1)!.content!, 'takes its messages away');
    });

    await t.step('an answer cut at the token limit says it was too long, not nothing', async () => {
      const rows = Array.from({ length: 40 }, (_, i) => `| 2013-07-${i} | 82.${i} |`).join('\n');
      const { reply } = await askWith(() => ({ tool: 'final_answer', args: { answer: rows }, cut: true }), shq('visa all min vikt'));
      assertEquals(reply.failure, 'too-long');
      assertEquals(reply.answer, 'The answer was too long to finish. Ask for less, such as the last 20 rows.');
      assertMatch(reply.error!, /longer than \d+ tokens/);
    });

    await t.step('the timeline keeps what the model thought and said, in order, and the chat stores it', async () => {
      const timelineChat = (await client.execJson<{ chat: { id: string } }>('assistant-chat create')).chat.id;
      const script: Script = (last) =>
        last.role === 'user'
          ? { tool: 'ls', args: { path: `${ALBUM}/files` }, reasoning: 'Albumets filer först.', content: 'Jag tittar i albumet.' }
          : { tool: 'final_answer', args: { answer: 'Tre bilder.' }, reasoning: 'Tre filer: det är svaret.', content: 'Tre bilder.' };
      const { reply } = await askWith(script, `--chat ${timelineChat} ${shq('vad finns i albumet')}`);
      const kinds = ['thinking', 'text', 'command', 'thinking'];
      assertEquals(reply.timeline?.map((event) => event.kind), kinds);
      const [thought, said, ran] = reply.timeline!;
      assertEquals(thought.kind === 'thinking' && thought.text, 'Albumets filer först.');
      assertEquals(said.kind === 'text' && said.text, 'Jag tittar i albumet.');
      assertEquals(ran.kind === 'command' && ran.tool, 'ls');
      // The command's card shows what it printed.
      assert(ran.kind === 'command' && ran.output?.includes('IMG_0001.jpg'), 'the output rides with the command');
      assertEquals(ran.kind === 'command' && ran.code, 0);
      const stored = await client.execJson<{ messages: { role: string; timeline?: { kind: string }[] }[] }>(`assistant-chat read ${timelineChat}`);
      assertEquals(stored.messages.at(-1)?.timeline?.map((event) => event.kind), kinds);
    });

    await t.step('--think asks the model to think, with room for it, and the question remembers it', async () => {
      const thinkChat = (await client.execJson<{ chat: { id: string } }>('assistant-chat create')).chat.id;
      const { reply, asked } = await askWith(() => tool('final_answer', { answer: 'Hej.' }), `--think --chat ${thinkChat} ${shq('hej')}`);
      assertEquals(reply.answer, 'Hej.');
      const sent = asked[0] as StubRequest & { chat_template_kwargs?: unknown };
      assertEquals(sent.chat_template_kwargs, { enable_thinking: true });
      assertEquals(sent.max_tokens, 4096);
      const stored = await client.execJson<{ messages: { role: string; think?: boolean }[] }>(`assistant-chat read ${thinkChat}`);
      assertEquals(stored.messages.map((m) => [m.role, m.think]), [['user', true], ['assistant', undefined]]);
      // Without it the request stays standard.
      const plain = await askWith(() => tool('final_answer', { answer: 'Hej.' }), shq('hej igen'));
      assertEquals((plain.asked[0] as { chat_template_kwargs?: unknown }).chat_template_kwargs, undefined);
    });

    await t.step('a thought that fills the token limit is asked once more, without thinking, to answer', async () => {
      const script: Script = (last) =>
        last.content?.startsWith('Your thinking used up') ? tool('final_answer', { answer: 'Tre bilder.' }) : { thought: 'Fler bilder först. '.repeat(20) };
      const { reply, asked } = await askWith(script, `--think ${shq('hur många bilder finns')}`);
      assertEquals(reply.answer, 'Tre bilder.');
      assertEquals(asked.map((request) => (request as { chat_template_kwargs?: unknown }).chat_template_kwargs), [{ enable_thinking: true }, {
        enable_thinking: false,
      }]);
      assertEquals(reply.timeline?.map((event) => event.kind), ['thinking']);
      // Once a turn: a second thought that fills the limit ends it.
      const stuck = await askWith(() => ({ thought: 'Fler bilder först. '.repeat(20) }), `--think ${shq('hur många bilder finns')}`);
      assertEquals([stuck.reply.failure, stuck.reply.error, stuck.asked.length], ['no-answer', 'the model gave no answer', 2]);
    });

    await t.step('a write is proposed, never run', async () => {
      const script: Script = () => tool('rm', { path: CECILIA });
      const { reply } = await askWith(script, shq('ta bort Cecilia Exempel'));
      assertEquals(reply.answer, 'Shall I run this?');
      assertEquals(reply.proposal!.commands[0].command, `rm ${CECILIA}`);
      assertEquals(reply.proposal!.targets.map((target) => target.path), [CECILIA]);
      assert(await vfs.exists(ADMIN_ACCESS, CECILIA), 'nothing was removed');
    });

    await t.step('a line that writes is proposed with its title, never run', async () => {
      const lines = 'echo "Hello World" > /home/admin/hw4.txt';
      const script: Script = () => tool('run_command', { command: lines, why: 'Skapa hw4.txt' });
      const { reply, asked } = await askWith(script, shq('skapa en fil hw4.txt med texten "Hello World"'));
      assert(asked[0].tools!.some((t) => t.function.name === 'run_command'), 'offered');
      assertEquals(reply.answer, 'Shall I run this?');
      assertEquals(reply.proposal!.title, 'Skapa hw4.txt');
      assertEquals(reply.proposal!.commands, [{ command: lines, label: 'Skapa hw4.txt' }]);
      assertEquals(reply.proposal!.targets.map((target) => target.path), ['/home/admin/hw4.txt']);
      await assertRejects(() => vfs.get(ADMIN_ACCESS, '/home/admin/hw4.txt'));
    });

    await t.step('any command is found, read about and run; a read runs at once', async () => {
      const script: Script = (last, messages) => {
        const previous = after(last, messages);
        if (last.role === 'user') return tool('find_commands', { query: 'list running services' });
        if (previous === 'find_commands') return tool('command_help', { name: 'service-list' });
        if (previous === 'command_help') return tool('run_command', { command: 'service-list' });
        return tool('final_answer', { answer: 'Tjänsterna körs.' });
      };
      const { reply, asked } = await askWith(script, shq('vilka tjänster körs?'));
      assertEquals(reply.error, undefined);
      assertEquals(reply.answer, 'Tjänsterna körs.');
      assertEquals(reply.steps.map((step) => [step.tool, (step as { verdict?: string }).verdict]), [
        ['find_commands', 'ran'],
        ['command_help', 'ran'],
        ['run_command', 'ran'],
      ]);
      // What the model was handed: the commands by name, the spec, and what the line printed.
      assertStringIncludes(asked[1].messages.at(-1)!.content!, '"name":"service-list"');
      assertStringIncludes(asked[2].messages.at(-1)!.content!, '"effect":"read"');
      assertEquals(reply.timeline?.filter((event) => event.kind === 'command').map((event) => (event as { line?: string }).line), [
        "assistant-commands find 'list running services'",
        'service-list --help',
        'service-list',
      ]);
    });

    await t.step('after the user runs a proposal, the turn goes on from what it printed', async () => {
      const chat = (await client.execJson<{ chat: { id: string } }>('assistant-chat create')).chat.id;
      const line = 'mkdir /home/admin/exempel';
      const proposing: Script = () => tool('run_command', { command: line, why: 'Skapa mappen' });
      const first = await askWith(proposing, `--chat ${chat} ${shq('skapa mappen exempel')}`);
      assertEquals(first.reply.proposal?.commands[0].command, line);

      // Nothing to go on with until the proposal is settled.
      await assertRejects(() => askWith(() => tool('final_answer', { answer: '-' }), `--chat ${chat} --resume`));

      await cmd.shouldSucceed(line);
      const results = [{ command: line, ok: true, exitCode: 0, output: 'skapad' }];
      await cmd.shouldSucceed(`assistant-chat outcome ${chat} ${first.reply.messageId} ran --results ${shq(JSON.stringify(results))}`);
      const going: Script = (last) =>
        last.role === 'user' && last.content!.includes('(the app: Done') ? tool('final_answer', { answer: 'Mappen finns nu.' }) : tool('final_answer', { answer: 'fel' });
      const { reply, asked } = await askWith(going, `--chat ${chat} --resume`);
      assertEquals(reply.answer, 'Mappen finns nu.');
      assertStringIncludes(asked[0].messages.at(-1)!.content!, 'It printed:\nskapad');
      // No new question was stored: the chat is the question, the proposal, its outcome and this answer.
      const stored = (await client.execJson<{ messages: { role: string; content: string }[] }>(`assistant-chat read ${chat}`)).messages;
      assertEquals(stored.map((message) => message.role), ['user', 'assistant', 'assistant', 'assistant']);
      assertEquals(stored.at(-1)!.content, 'Mappen finns nu.');
    });

    await t.step('a declined proposal is told to the model as declined', async () => {
      const chat = (await client.execJson<{ chat: { id: string } }>('assistant-chat create')).chat.id;
      const first = await askWith(() => tool('run_command', { command: 'rm /home/admin/exempel' }), `--chat ${chat} ${shq('ta bort mappen')}`);
      await cmd.shouldSucceed(`assistant-chat outcome ${chat} ${first.reply.messageId} dismissed`);
      const { asked } = await askWith(() => tool('final_answer', { answer: 'Då låter jag den vara.' }), `--chat ${chat} --resume`);
      assertStringIncludes(asked[0].messages.at(-1)!.content!, 'Declined by the user, not run');
    });

    await t.step('a reading command given a flag that writes is proposed, and what may not run is refused', async () => {
      const setting: Script = () => tool('run_command', { command: `attrs -s 'description=Ett exempel' ${ANNA}` });
      assertEquals((await askWith(setting, shq('sätt beskrivningen'))).reply.proposal?.commands[0].command, `attrs -s 'description=Ett exempel' ${ANNA}`);

      const editing: Script = (last) => last.role === 'user' ? tool('run_command', { command: 'edit /home/admin/x.txt' }) : tool('final_answer', { answer: 'Det går inte.' });
      const { reply, asked } = await askWith(editing, shq('öppna x.txt i editorn'));
      assertEquals(reply.proposal, undefined);
      assertStringIncludes(asked[1].messages.at(-1)!.content!, 'edit cannot be run from the chat');

      // A command the shell does not have is told to the model, not proposed to fail on the card.
      const touching: Script = (last) => last.role === 'user' ? tool('run_command', { command: 'touch /home/admin/test.txt' }) : tool('final_answer', { answer: '-' });
      const touched = await askWith(touching, shq('skapa filen test.txt'));
      assertEquals(touched.reply.proposal, undefined);
      assertStringIncludes(touched.asked[1].messages.at(-1)!.content!, 'touch is not an EiN command');

      // An unquoted & in a path backgrounds half the line; the model hears to quote it, nothing is proposed.
      const looping: Script = (last) =>
        last.role === 'user' ? tool('run_command', { command: 'for f in /test/albums/Anna_&_Bo/*.jpg; do stat "$f"; done' }) : tool('final_answer', { answer: '-' });
      const looped = await askWith(looping, shq('när togs bilderna?'));
      assertEquals(looped.reply.proposal, undefined);
      assertStringIncludes(looped.asked[1].messages.at(-1)!.content!, `Put the path in single quotes`);
    });

    await t.step('a picture no result listed is not shown', async () => {
      const { reply } = await askWith(() => tool('final_answer', { answer: 'Här.', paths: [`${ALBUM}/files/hemlig.jpg`] }), shq('vad finns i hemlig.jpg?'));
      assertEquals(reply.media, []);
    });

    await t.step('a Markdown link in the answer stays only if it opens something the asker can see', async () => {
      const answer = `**Anna:** [Anna Exempel](${ANNA}) och [Bo](/archive/people/Ingen_Sadan).`;
      const { reply } = await askWith(() => tool('final_answer', { answer }), shq('vem är Anna?'));
      assertEquals(reply.answer, `**Anna:** [Anna Exempel](${ANNA}) och Bo.`);
    });

    await t.step('pictures the question says are shown already are left out', async () => {
      const script: Script = (last, messages) => after(last, messages) === 'search' ? tool('final_answer', { answer: 'Fler.' }) : tool('search', SUMMER);
      const shown = `${ALBUM}/files/IMG_0001.jpg`;
      const { reply } = await askWith(script, `--context ${shq(JSON.stringify({ shown: [shown] }))} ${shq('fler bilder på Anna Exempel')}`);
      assertEquals(reply.media.map((hit) => hit.path), [`${ALBUM}/files/IMG_0002.jpg`]);
    });

    await t.step('prose is corrected once, then taken as the answer', async () => {
      const { reply, asked } = await askWith(() => 'Hej! Jag kan söka i arkivet.', shq('hej'));
      assertEquals(asked.length, 2);
      assertEquals(asked[1].messages.slice(-2).map((m) => m.role), ['assistant', 'user']);
      assertEquals(reply.answer, 'Hej! Jag kan söka i arkivet.');
      assertEquals(reply.error, undefined);
      // The first try is the answer said too early, not a step: the timeline does not show it twice.
      assertEquals(reply.timeline, []);
    });

    await t.step('the same call twice is answered from memory, and a model stuck on it is stopped', async () => {
      const { reply, asked } = await askWith(() => tool('stat', { path: ANNA }), shq('vem är Anna Exempel?'));
      assertEquals(reply.steps.map((step) => (step as { verdict?: string }).verdict), ['ran', 'repeated', 'repeated', 'repeated']);
      assertEquals(reply.error, 'the model kept repeating the same command');
      // The error result alone does not stop the model; the user-role nudge after it does.
      assertEquals(asked[2].messages.slice(-2).map((m) => m.role), ['tool', 'user']);
      assertStringIncludes(asked[2].messages.at(-1)!.content!, 'Answer now with final_answer');
      assertEquals(reply.failure, 'no-answer');
      assertEquals(reply.answer, 'The assistant could not answer this question.');
      // After the third repeat it is offered only final_answer, and calls stat anyway.
      assertEquals(asked.length, 5);
      assertEquals(asked[4].tools?.map((offered) => offered.function.name), ['final_answer']);
    });

    await t.step('a model stuck repeating a call is asked once more, offered only final_answer and without thinking', async () => {
      const script: Script = (_last, messages) =>
        messages.at(-1)?.role === 'user' && messages.filter((message) => message.tool_calls).length > 3
          ? tool('final_answer', { answer: 'Anna Exempel är med.' })
          : tool('stat', { path: ANNA });
      const { reply, asked } = await askWith(script, `--think ${shq('vem är Anna Exempel?')}`);
      assertEquals(reply.answer, 'Anna Exempel är med.');
      assertEquals(reply.error, undefined);
      assertEquals(reply.steps.map((step) => (step as { verdict?: string }).verdict), ['ran', 'repeated', 'repeated', 'repeated']);
      const last = asked.at(-1) as StubRequest & { chat_template_kwargs?: unknown };
      assertEquals([asked.length, last.tools?.map((offered) => offered.function.name), last.chat_template_kwargs], [5, ['final_answer'], {
        enable_thinking: false,
      }]);
    });

    await t.step('a call repeated between new ones does not end the turn: the model is still finding things out', async () => {
      // Search, look at one, search again, look at the next: three repeats, each after a new call.
      const looks = [ANNA, BO, CECILIA];
      const script: Script = (_last, messages) => {
        const calls = messages.filter((message) => message.tool_calls).length;
        if (calls >= looks.length * 2) return tool('final_answer', { answer: 'Tre personer.' });
        return calls % 2 === 0 ? tool('search', SUMMER) : tool('stat', { path: looks[(calls - 1) / 2] });
      };
      const { reply } = await askWith(script, shq('hur många är med?'));
      assertEquals(reply.steps.map((step) => (step as { verdict?: string }).verdict), ['ran', 'ran', 'repeated', 'ran', 'repeated', 'ran']);
      assertEquals(reply.error, undefined);
      assertEquals(reply.answer, 'Tre personer.');
    });

    // Earlier turns that the model's context cannot hold beside the turn: a question and a long answer each.
    const history = shq(JSON.stringify([1, 2, 3].flatMap((n) => [
      { role: 'user', content: `gammal fråga ${n}` },
      { role: 'assistant', content: `svar ${n}: ${'lång text '.repeat(160)}` },
    ])));
    const answering = () => tool('final_answer', { answer: 'Svar.' });
    const withHistory = (await askWith(answering, `--history ${history} ${shq('ny fråga')}`)).asked[0];
    const oneEarlierTurn = stubTokens({ messages: withHistory.messages.slice(1, 3) });

    await t.step('a turn refused as too long for the model goes on without the oldest turns, not as the model being away', async () => {
      const context = stubTokens(withHistory) - oneEarlierTurn;
      const { reply, asked } = await askWith(answering, `--history ${history} ${shq('ny fråga')}`, 'CFG_LLM_MAX_TOKENS=100 ', { context, props: false });
      assertEquals(reply.error, undefined);
      assertEquals(reply.answer, 'Svar.');
      assertEquals(asked.length, 2);
      assert(stubTokens(asked[0]) > context && stubTokens(asked[1]) <= context);
      assertEquals(asked[1].messages[1].role, 'user', 'the history starts with something said');
      assert(!asked[1].messages.some((message) => message.content === 'gammal fråga 1'), 'the oldest turn went');
      assertMatch(asked[1].messages.at(-1)!.content!, /ny fråga$/);
    });

    await t.step("a turn makes room before a call that would not fit the model's context", async () => {
      await cmd.shouldSucceed(`echo ${shq('rad '.repeat(1500))} > /tmp/long.txt`);
      const script: Script = (last) => last.role === 'user' ? tool('cat', { path: '/tmp/long.txt' }) : tool('final_answer', { answer: 'Svar.' });
      // Room for the history and the question, not for them and what cat prints.
      const context = stubTokens(withHistory) + 100 + 800;
      const { reply, asked } = await askWith(script, `--history ${history} ${shq('ny fråga')}`, 'CFG_LLM_MAX_TOKENS=100 ', { context });
      assertEquals(reply.answer, 'Svar.');
      assertEquals(asked.length, 2);
      for (const request of asked) assert(stubTokens(request) <= context, 'nothing was sent that did not fit');
      assert(asked[1].messages.length < asked[0].messages.length + 2, 'earlier turns went to make room');
      assertEquals(asked[1].messages.at(-1)!.role, 'tool', 'and what cat printed is all there');
    });

    await t.step("a turn the model's context cannot hold at all is no answer, not the model being away", async () => {
      const { reply, asked } = await askWith(answering, `--history ${history} ${shq('ny fråga')}`, '', { context: 100, props: false });
      assertEquals(reply.failure, 'no-answer');
      assertMatch(reply.error!, /does not fit the model/);
      assertEquals(asked.length, 2, 'asked again once room was made, then given up');
    });

    await t.step('an unknown command is an error result the model can recover from', async () => {
      const script: Script = (last) => last.role === 'user' ? tool('rm-rf', { path: '/' }) : tool('final_answer', { answer: 'Det kan jag inte.' });
      const { reply, asked } = await askWith(script, shq('radera allt'));
      assertEquals(reply.answer, 'Det kan jag inte.');
      assertStringIncludes(asked[1].messages[asked[1].messages.length - 1].content!, 'no command named rm-rf');
    });

    await t.step('--max-steps ends the commands and asks for an answer', async () => {
      const script: Script = (last) =>
        last.role === 'tool'
          ? tool('stat', { path: BO })
          : last.content?.includes('as many commands')
          ? tool('final_answer', { answer: 'Anna.' })
          : tool('stat', { path: ANNA });
      const { reply, asked } = await askWith(script, `--max-steps 1 ${shq('vem är Anna Exempel?')}`);
      assertStringIncludes(asked[1].messages[asked[1].messages.length - 1].content!, 'as many commands');
      assertEquals(reply.answer, 'Anna.');
    });

    await t.step('no model service at all is an apology with the reason, exit 0', async () => {
      const reply = await client.execJson<AssistantReply>(`CFG_LLM_WAIT=0 CFG_LLM_URL=http://127.0.0.1:1 assistant-ask ${shq('hej')}`);
      assert(reply.error?.includes('unreachable'), reply.error);
      assertEquals(reply.answer, 'The assistant is not available right now.');
      assertEquals(reply.failure, 'unavailable');
      assertEquals(reply.steps, []);
    });

    await t.step('a progress id reports thinking while the model answers, and is gone after', async () => {
      const progressId = '12345678-1234-4234-9234-123456789abc';
      const model = startStubLlm(() => tool('final_answer', { answer: 'ok' }), { delayMs: 300 });
      const waitFor = async (phase: 'waiting' | 'thinking' | null) => {
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          const status = await client.execJson<{ phase: 'waiting' | 'thinking' | null }>(`assistant-chat progress ${progressId}`);
          if (status.phase === phase) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error(`assistant progress never became ${phase}`);
      };
      try {
        const pending = client.execJson<AssistantReply>(`CFG_LLM_URL=${model.url} assistant-ask --progress ${progressId} hej`);
        // "waiting" covers only the setup before the first model call, so it can be over before the
        // first poll; "thinking" lasts the answer.
        await waitFor('thinking');
        await pending;
        assertEquals((await client.execJson<{ phase: string | null }>(`assistant-chat progress ${progressId}`)).phase, null);
      } finally {
        await model.close();
      }
    });

    await t.step('a watched turn waits for a model that is away, says so, and notes the wait', async () => {
      const progressId = '12345678-1234-4234-9234-123456789abe';
      const model = startStubLlm(() => tool('final_answer', { answer: 'ok' }), { away: 1 });
      const phases = new Set<string | null>();
      try {
        const pending = client.execJson<AssistantReply>(`CFG_LLM_URL=${model.url} assistant-ask --progress ${progressId} hej`);
        let done = false;
        void pending.finally(() => done = true);
        while (!done) {
          phases.add((await client.execJson<{ phase: string | null }>(`assistant-chat progress ${progressId}`)).phase);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const reply = await pending;
        assertEquals(reply.answer, 'ok');
        assert(phases.has('away'), `phases seen: ${[...phases]}`);
        assertEquals(reply.timeline?.[0]?.kind, 'waited');
        assert((reply.timing?.away ?? 0) >= 900, `away ${reply.timing?.away}`);
        assertEquals(model.requests.length, 2);
      } finally {
        await model.close();
      }
    });

    await t.step('a watched turn streams: the commands so far and the answer as it is written', async () => {
      const progressId = '12345678-1234-4234-9234-123456789abd';
      const answer = 'Albumet har tre bilder från sommaren 2019.';
      const model = startStubLlm(
        (request) => request.messages[request.messages.length - 1].role === 'user' ? tool('ls', { path: `${ALBUM}/files` }) : tool('final_answer', { answer }),
        { chunkDelayMs: 25 },
      );
      type Live = { phase: string | null; timeline?: { kind: string; tool?: string }[]; draft?: { tool?: string; args?: string } };
      const samples: Live[] = [];
      try {
        const pending = client.execJson<AssistantReply>(
          `CFG_LLM_URL=${model.url} assistant-ask --progress ${progressId} ${shq('vad finns i albumet')}`,
        );
        let done = false;
        void pending.finally(() => done = true);
        while (!done) {
          samples.push(await client.execJson<Live>(`assistant-chat progress ${progressId}`));
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const reply = await pending;
        assertEquals(reply.answer, answer);
        assert(model.requests.every((request) => request.stream), 'a watched turn asks for a stream');
        // The first call streams before any command has run; the answer streams after the ls.
        assert(samples.some((live) => !live.timeline?.length && live.draft?.tool === 'ls'), 'the ls call was seen forming');
        const partial = samples.find((live) => live.timeline?.[0]?.tool === 'ls' && live.draft?.tool === 'final_answer' && live.draft.args !== JSON.stringify({ answer }));
        assert(partial, 'the answer was seen half written, after the ls');
      } finally {
        await model.close();
      }
    });

    await t.step('the guest is refused before anything runs, until the archive is open to it', async () => {
      const guest = await testCtx.server.createShellClient({ login: false });
      const asGuest = testCommands(guest);
      const model = startStubLlm(() => tool('final_answer', { answer: 'Hej.' }));
      const line = (env = '') => `${env}CFG_LLM_URL=${model.url} assistant-ask ${shq('bilder på Anna Exempel')}`;
      try {
        await asGuest.shouldFailWith(line(), 'sign in first');
        // Its own command line does not open the archive to it.
        await asGuest.shouldFailWith(line('CFG_GUEST_BROWSING=true '), 'sign in first');
        assertEquals(model.requests.length, 0);

        await cmd.shouldSucceed('config set CFG_GUEST_BROWSING true');
        const reply = await guest.execJson<AssistantReply>(line());
        assertEquals(reply.answer, 'Hej.');
      } finally {
        await cmd.shouldSucceed('config unset CFG_GUEST_BROWSING');
        await model.close();
        guest.close();
      }
    });

    await t.step("the guest's change is never proposed: the model hears it needs signing in", async () => {
      const guest = await testCtx.server.createShellClient({ login: false });
      const write = 'echo hej > /tmp/guest.txt';
      const model = startStubLlm(({ messages }) =>
        messages.at(-1)!.role === 'user' ? tool('run_command', { command: write }) : tool('final_answer', { answer: 'Logga in först.' })
      );
      const history = JSON.stringify([{ role: 'user', content: 'hej' }, { role: 'assistant', content: 'Hej.' }]);
      try {
        await cmd.shouldSucceed('config set CFG_GUEST_BROWSING true');
        const reply = await guest.execJson<AssistantReply>(
          `CFG_LLM_URL=${model.url} assistant-ask --history ${shq(history)} ${shq('skapa en fil')}`,
          { timeout: 30_000 },
        );
        assertEquals(reply.answer, 'Logga in först.');
        assertEquals(reply.proposal, undefined);
        const told = JSON.stringify(model.requests[1].messages.at(-1));
        assert(told.includes('may change nothing'), told);
        // The conversation the browser holds reached the model before the question.
        assert(model.requests[0].messages.some((message) => message.role === 'assistant' && message.content === 'Hej.'), 'history sent');
      } finally {
        await cmd.shouldSucceed('config unset CFG_GUEST_BROWSING');
        await model.close();
        guest.close();
      }
    });

    await t.step('the questions the modules suggest, in module order, for an empty chat', async () => {
      await cmd.shouldSucceed(`printf '# one a line\\nVad finns i albumet?\\n' > /etc/assistant.d/test/examples`);
      const { examples } = await client.execJson<{ examples: string[] }>('assistant-chat examples');
      assertEquals(examples, ['Which services are running?', 'Vad finns i albumet?']);
    });

    await t.step("usage errors are the caller's, and fail", async () => {
      await cmd.shouldFailWith('assistant-ask', 'missing message');
      await cmd.shouldFailWith(`assistant-ask --history nope ${shq('hej')}`, '--history must be');
      await cmd.shouldFailWith(`assistant-ask --context '[]' ${shq('hej')}`, '--context must be');
      await cmd.shouldFailWith(`assistant-ask --max-steps 0 ${shq('hej')}`, '--max-steps must be');
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
