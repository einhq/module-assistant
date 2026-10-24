/** The fast path's reading of a sentence: what is a request to see, and what is left as content. */

import { assertEquals } from '@std/assert';
import { countWords, isFastShape } from '../lib/fast.ts';

Deno.test('countWords: the page size the sentence asks for', () => {
  assertEquals(countWords('visa 6 bilder på Tyra'), 6);
  assertEquals(countWords('show 3 photos of Anna'), 3);
  assertEquals(countWords('visa 99 bilder'), 24);
  assertEquals(countWords('visa bilder från 2019'), 24);
});

Deno.test('isFastShape: a request to see, without a question inside it', () => {
  assertEquals(isFastShape('Visa bilder på Olof Strand från 2019'), true);
  assertEquals(isFastShape('show photos of Anna in Italy'), true);
  assertEquals(isFastShape('Bilder från 2003'), true);
  assertEquals(isFastShape('Hur många gånger har jag varit i Italien?'), false);
  assertEquals(isFastShape('Visa bilder på mig'), false);
  assertEquals(isFastShape('När var vi senast i Italien?'), false);
  assertEquals(isFastShape('Vad är det på den här bilden?'), false);
});
