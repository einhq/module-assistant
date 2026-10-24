/**
 * The drawer's half of the assistant contract: what a reply's parts become in the app.
 */

import { assertEquals } from '@std/assert';
import {
  draftView,
  eventsOf,
  groupEvents,
  llmNotice,
  partialJsonString,
  proposalScript,
  readableOutput,
  replyMediaItems,
  routeForLink,
  routeForNode,
  routeForSearch,
  thoughtLine,
  waitedLine,
  waitingLine,
  workLine,
} from '../assistant.ts';
import { nodeRoutes } from '@ein/ui/signals';

// A module's `ui.open`, as the shell reads it from the UI manifest.
nodeRoutes.value = { person: '/people/{name}', location: '/locations/{name}', album: '/albums/{path}' };

Deno.test("a link follows its type's ui.open route, as the search cards do", () => {
  assertEquals(routeForLink({ label: 'Anna', type: 'person', path: '/archive/people/anna-andersson' }), '/people/anna-andersson');
  assertEquals(routeForLink({ label: 'Göteborg', type: 'location', path: '/archive/locations/göteborg/' }), '/locations/g%C3%B6teborg');
  assertEquals(routeForLink({ label: 'Summer', type: 'album', path: '/archive/albums/summer 2019' }), '/albums/%2Farchive%2Falbums%2Fsummer%202019');
});

Deno.test('a file opens in the lightbox, and a type no installed module opens goes nowhere', () => {
  assertEquals(routeForNode('file', '/archive/albums/Exempelalbum_2019/files/IMG_0001.jpg'), '/media/%2Farchive%2Falbums%2FExempelalbum_2019%2Ffiles%2FIMG_0001.jpg');
  assertEquals(routeForNode('directory', '/home/admin'), undefined);
  const routes = nodeRoutes.value;
  nodeRoutes.value = {};
  try {
    assertEquals(routeForLink({ label: 'Anna', type: 'person', path: '/archive/people/anna-andersson' }), undefined);
  } finally {
    nodeRoutes.value = routes;
  }
});

Deno.test("routeForSearch puts the assistant's filters into the parameters of the page that shows them", () => {
  assertEquals(
    routeForSearch({ query: 'sailboat', kinds: ['photo'], subjects: ['person:anna', 'person:bo'], fromYear: 2019, sort: '-time' }),
    '/media?q=sailboat&kind=photo&subject=person%3Aanna&subject=person%3Abo&from=2019&sort=-time',
  );
  assertEquals(
    routeForSearch({ region: { shape: 'bbox', north: 47.1, south: 35.4, east: 18.5, west: 6.6 }, sort: '-time' }),
    '/media?bbox=47.1%2C35.4%2C18.5%2C6.6&sort=-time',
  );
  // Only albums, people, locations, devices and tracks belong on the search page.
  assertEquals(routeForSearch({ query: 'sailboat', kinds: ['album'] }), '/search?q=sailboat&kind=album');
  // A picture to look like is a question about pictures.
  assertEquals(routeForSearch({ like: '/archive/albums/Summer/files/IMG_0001.jpg' }), '/media?like=%2Farchive%2Falbums%2FSummer%2Ffiles%2FIMG_0001.jpg');
});

Deno.test("replyMediaItems makes lightbox items from the reply's refs", () => {
  const [item] = replyMediaItems({ media: [{ path: '/media/a.jpg', name: 'a.jpg', mimetype: 'image/jpeg', width: 400, height: 300, takenAt: '2019-07-12T10:00:00' }] });
  assertEquals(item.path, '/media/a.jpg');
  assertEquals(item.type, 'photo');
  assertEquals(item.takenAt, '2019-07-12T10:00:00');
  assertEquals(item.thumbnailUrl.startsWith('/file/media/a.jpg/thumbnails/'), true);
});

Deno.test('proposalScript: set -e, then each command under its explanation', () => {
  const script = proposalScript({
    title: 'Create person X; link X to parent Y',
    commands: [{ command: 'person-create /people/x --name X', label: 'Create the person X' }, {
      command: 'person-set-parent /people/x /people/y',
      label: 'Make Y a parent of X',
    }],
    targets: [],
  });
  assertEquals(script, 'set -e\n\n# Create the person X\nperson-create /people/x --name X\n\n# Make Y a parent of X\nperson-set-parent /people/x /people/y');
});

Deno.test('partialJsonString reads a string field as far as the stream has written it', () => {
  assertEquals(partialJsonString('{"answer', 'answer'), undefined);
  assertEquals(partialJsonString('{"answer": "', 'answer'), '');
  assertEquals(partialJsonString('{"answer":"Två \\"bå', 'answer'), 'Två "bå');
  assertEquals(partialJsonString('{"answer":"rad\\nnästa\\', 'answer'), 'rad\nnästa');
  assertEquals(partialJsonString('{"answer":"\\u00e5\\u00e', 'answer'), 'å');
  assertEquals(partialJsonString('{"answer":"klar","paths":["/a"]}', 'answer'), 'klar');
});

Deno.test('draftView: the answer as it is written, or the call as it forms', () => {
  assertEquals(draftView({ reasoning: '', content: '', tool: 'final_answer', args: '{"answer":"Tre bil' }), { reasoning: '', text: 'Tre bil' });
  assertEquals(draftView({ reasoning: ' hmm ', content: '', tool: 'search', args: '{"query":"båt' }), { reasoning: 'hmm', text: '', call: 'search {"query":"båt' });
  assertEquals(draftView({ reasoning: '', content: 'Hej' }), { reasoning: '', text: 'Hej' });
});

Deno.test('eventsOf: the stored timeline, or for an older turn its commands', () => {
  const step = { tool: 'ls', args: {}, summary: 'ls /', ms: 20 };
  const timeline = [{ kind: 'thinking' as const, text: 'hmm', ms: 900 }, { kind: 'command' as const, ...step }];
  assertEquals(eventsOf({ timeline, steps: [step] }), timeline);
  assertEquals(eventsOf({ steps: [step] }), [{ kind: 'command', ...step }]);
  assertEquals(eventsOf({}), []);
  assertEquals(thoughtLine(1234), 'Thought for 1.2s');
  assertEquals(thoughtLine(), 'Thought');
});

Deno.test('groupEvents folds commands in a row, with the thoughts before them; words end a run', () => {
  const cmd = (tool: string, ms = 100, failed = false) => ({ kind: 'command' as const, tool, args: {}, summary: tool, ms, ...(failed ? { failed } : {}) });
  const thought = (text: string) => ({ kind: 'thinking' as const, text });
  const said = (text: string) => ({ kind: 'text' as const, text });
  const entries = groupEvents([thought('a'), cmd('ls'), thought('b'), cmd('stat', 300, true), said('Jag letar vidare.'), cmd('find'), thought('svaret')]);
  assertEquals(entries.map((entry) => entry.kind === 'work' ? `work:${entry.items.map((item) => item.kind === 'command' ? item.tool : 'thought').join(',')}` : entry.kind), [
    'work:thought,ls,thought,stat',
    'text',
    'work:find',
    'thinking',
  ]);
  const first = entries[0];
  assertEquals(first.kind === 'work' && workLine(first), 'Ran 2 commands, 1 failed · 0.4s');
  const busy = groupEvents([cmd('ls'), { kind: 'command', tool: '', args: {}, summary: 'stat /', live: 'running' }])[0];
  assertEquals(busy.kind === 'work' && workLine(busy), 'Running commands… 1 done');
  assertEquals(groupEvents([thought('bara tanke')]).map((entry) => entry.kind), ['thinking']);
  // Keys are the index of the entry's first event, stable as a live turn grows.
  assertEquals(entries.map((entry) => entry.key), [0, 4, 5, 6]);
});

Deno.test('a wait for the model is its own entry, ending a run; the live turn says what it waits for', () => {
  const cmd = (tool: string) => ({ kind: 'command' as const, tool, args: {}, summary: tool, ms: 100 });
  const entries = groupEvents([cmd('ls'), { kind: 'waited', ms: 81_400 }, cmd('stat')]);
  assertEquals(entries.map((entry) => entry.kind), ['work', 'waited', 'work']);
  assertEquals(waitedLine(81_400), 'Waited 81s for the language model to restart');
  assertEquals(waitingLine('away'), 'The language model is restarting; waiting for it…');
  assertEquals(waitingLine('thinking'), 'Thinking…');
});

Deno.test('readableOutput indents JSON and leaves text alone', () => {
  assertEquals(readableOutput('{"a":1}'), '{\n  "a": 1\n}');
  assertEquals(readableOutput('plain\ntext'), 'plain\ntext');
});

Deno.test('llmNotice names the provider, and says nothing of ours', () => {
  const ours = { url: 'http://127.0.0.1:8190', model: 'qwen3.5-4b', kind: 'ours' as const };
  assertEquals(llmNotice(null), null);
  assertEquals(llmNotice(ours), null);
  assertEquals(llmNotice({ ...ours, card: 'card' }), null);
  const external = llmNotice({ url: 'https://api.example.com', model: 'big-model', kind: 'external', provider: 'Example AI' });
  assertEquals(external?.text.startsWith('Answered by Example AI:'), true);
  assertEquals(external?.text.includes('leave this server'), true);
});
