import { assertEquals } from '@std/assert';
import { keepKnownLinks } from '../lib/answer-links.ts';

const known = new Map([['/archive/people/Anna_Exempel', 'person'], ['/archive/albums/Exempelalbum_2019/files/IMG_0001.jpg', 'file']]);
const typeOf = (path: string) => Promise.resolve(known.get(path));

Deno.test('a link to a node that exists is kept, one to a made-up path becomes its words', async () => {
  const text = '**Föräldrar:**\n\n- [Anna Exempel](/archive/people/Anna_Exempel), född 1950\n- [Bo Exempel](/archive/people/Bo_Exempel), född 1948\n';
  assertEquals(await keepKnownLinks(text, typeOf), {
    text: '**Föräldrar:**\n\n- [Anna Exempel](/archive/people/Anna_Exempel), född 1950\n- Bo Exempel, född 1948\n',
    // Each kept link with its node's type, which the chat opens it by.
    types: { '/archive/people/Anna_Exempel': 'person' },
  });
});

Deno.test('links in a table, by reference and percent-encoded are all checked; web links and plain text are left alone', async () => {
  const text = [
    '| Namn | Bild |',
    '| --- | --- |',
    '| [Cecilia *Exempel*](/archive/people/Cecilia_Exempel) | [bild](/archive/albums/Exempelalbum_2019/files/IMG%5F0001.jpg) |',
    '',
    'Se [Anna][a] och [Bo][b], eller [Exempelstad](https://example.org/exempelstad).',
    '',
    '[a]: /archive/people/Anna_Exempel',
    '[b]: /archive/people/Bo_Exempel',
    '',
  ].join('\n');
  assertEquals(
    (await keepKnownLinks(text, typeOf)).text,
    [
      '| Namn | Bild |',
      '| --- | --- |',
      '| Cecilia *Exempel* | [bild](/archive/albums/Exempelalbum_2019/files/IMG%5F0001.jpg) |',
      '',
      'Se [Anna][a] och Bo, eller [Exempelstad](https://example.org/exempelstad).',
      '',
      '[a]: /archive/people/Anna_Exempel',
      '',
      '',
    ].join('\n'),
  );
});

Deno.test('an answer without links is returned as it is, without asking', async () => {
  let asked = 0;
  const text = 'Anna Exempel är född 1950-04-01.';
  assertEquals(await keepKnownLinks(text, () => Promise.resolve(String(++asked))), { text, types: {} });
  assertEquals(asked, 0);
});
