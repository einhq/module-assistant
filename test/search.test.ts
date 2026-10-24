/** The search command line a filter set becomes. */

import { assertEquals } from '@std/assert';
import { searchCommand } from '../lib/search.ts';

Deno.test('searchCommand spells every filter as the search flag the UI also uses', () => {
  assertEquals(
    searchCommand({ query: "it's a boat", kinds: ['photo'], subjects: ['person:anna', 'person:bo', 'location:park'], sort: '-time' }, 12, '2011', '2011-08'),
    "search 'it'\\''s a boat' --kind photo --subject 'person:anna' --subject 'person:bo' --subject 'location:park' --from 2011 --to 2011-08 --sort=-time -l 12 --max-scan 20000 --fields description",
  );
  assertEquals(
    searchCommand({ subjects: ['person:anna'], subjectNames: ['person:Bo'] }, 3),
    "search --subject 'person:anna' --subject-name 'person:Bo' -l 3 --max-scan 20000 --fields description",
  );
  assertEquals(
    searchCommand({ region: { shape: 'bbox', north: 47.1, south: 35.4, east: 18.5, west: -6.6 } }, 3),
    'search --bbox=47.1,35.4,18.5,-6.6 -l 3 --max-scan 20000 --fields description',
  );
});
