import { assertEquals, assertStringIncludes } from '@std/assert';
import { ampersandInPath } from '../lib/agent.ts';

const DIR = '/archive/albums/Fest_hos_Anna_&_Bo';

Deno.test('an unquoted & in a path is named, and the line handed back with the path quoted, its glob outside the quotes', () => {
  const said = ampersandInPath(`cat -t ${DIR}/files/*.JPG | grep takenAt`)!;
  assertStringIncludes(said, `the path ${DIR}/files/*.JPG has & in it`);
  assertStringIncludes(said, `run this line instead:\ncat -t '${DIR}/files'/*.JPG | grep takenAt`);
  assertStringIncludes(ampersandInPath(`for f in ${DIR}/P31300*.JPG; do stat "$f"; done`)!, `'${DIR}'/P31300*.JPG`);
  assertStringIncludes(ampersandInPath(`stat ${DIR}`)!, `'${DIR}'`);
  assertStringIncludes(ampersandInPath(`dir=${DIR}; ls $dir`)!, `'${DIR}'`);
});

Deno.test('a quoted or escaped &, and & as an operator, are left alone', () => {
  for (
    const line of [
      `ls '${DIR}'/files`,
      `ls "${DIR}/files"`,
      'ls /archive/albums/Fest_hos_Anna_\\&_Bo',
      'ls /a && ls /b',
      'ls /a&&ls /b',
      'ls /a >/dev/null 2>&1',
      'ls /a&>/dev/null',
      'sleep 1 & ls /a',
      'ls /a&',
      'echo Anna&Bo',
    ]
  ) assertEquals(ampersandInPath(line), undefined, line);
});
