import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { resultJson } from '../lib/agent.ts';
import { chartFrom, logPoints, MAX_SLICES, MAX_WRITTEN_POINTS, numberOf } from '../lib/chart.ts';

const WEIGHT = '/archive/people/Anna_Exempel/measurements/weight';
// As `cat -t` prints an imported log: in the order the entries were written, not when they happened.
const PRINTED = [
  '2012-05-01T00:00:00.000Z\t{"value":83.2}',
  '2012-04-10T00:00:00.000Z\t{"value":83.4}',
  '2012-04-11T00:00:00.000Z\t{"value":82.4}',
  'not an entry',
  '2012-04-12T00:00:00.000Z\t{"note":"no number"}',
].join('\n');
const logs = new Map([[WEIGHT, PRINTED]]);
const readLog = (path: string) => Promise.resolve(logs.get(path));
const unitOf = (path: string) => Promise.resolve(path === WEIGHT ? 'kg' : undefined);

Deno.test('a log is plotted from what cat printed, in time order, with its own unit', async () => {
  assertEquals(await chartFrom({ kind: 'line', title: 'Vikt', source: WEIGHT }, readLog, unitOf), {
    kind: 'line',
    title: 'Vikt',
    unit: 'kg',
    points: [
      { label: '2012-04-10', value: 83.4 },
      { label: '2012-04-11', value: 82.4 },
      { label: '2012-05-01', value: 83.2 },
    ],
  });
});

Deno.test('a source that is not a readable log draws nothing, whatever points came with it', async () => {
  assertEquals(await chartFrom({ kind: 'line', source: '/archive/people/Bo/measurements/weight', points: [['a', 1], ['b', 2]] }, readLog), undefined);
});

Deno.test('entries sharing a day are labelled to the minute, the others by day; a named field is read', () => {
  const mixed = '2020-01-02T00:00:00.000Z\t5\n2020-01-01T08:30:00.000Z\t3\n2020-01-01T20:15:00.000Z\t4';
  assertEquals(logPoints(mixed), [{ label: '2020-01-01 08:30', value: 3 }, { label: '2020-01-01 20:15', value: 4 }, { label: '2020-01-02', value: 5 }]);
  const printed = '2020-01-01T08:30:00.000Z\t{"sys":120,"dia":80}\n2020-01-01T20:15:00.000Z\t{"sys":130,"dia":85}';
  assertEquals(logPoints(printed, 'dia'), [{ label: '2020-01-01 08:30', value: 80 }, { label: '2020-01-01 20:15', value: 85 }]);
  // Two numbers and no field named: which one is meant is not the code's to guess.
  assertEquals(logPoints(printed), []);
});

Deno.test('written points take the shapes the model writes, and drop what is not a number', async () => {
  const chart = await chartFrom(
    { type: 'Column', points: [{ label: '2019', value: '1 204' }, { x: 2020, y: '82,5 kg' }, ['2021', 3], { label: '2022', value: 'many' }] },
    readLog,
  );
  assertEquals(chart, { kind: 'bar', points: [{ label: '2019', value: 1204 }, { label: '2020', value: 82.5 }, { label: '2021', value: 3 }] });
});

Deno.test('the model writes at most so many points; a single point or an unknown kind is no chart', async () => {
  const many = Array.from({ length: MAX_WRITTEN_POINTS + 10 }, (_, index) => ({ label: `p${index}`, value: index }));
  assertEquals((await chartFrom({ kind: 'bar', points: many }, readLog))?.points.length, MAX_WRITTEN_POINTS);
  assertEquals(await chartFrom({ kind: 'bar', points: [{ label: 'a', value: 1 }] }, readLog), undefined);
  assertEquals(await chartFrom({ kind: 'scatter', points: [['a', 1], ['b', 2]] }, readLog), undefined);
  assertEquals(await chartFrom('a chart', readLog), undefined);
});

Deno.test('a pie keeps positive slices, and too many of them are drawn as bars', async () => {
  const pie = await chartFrom({ kind: 'pie', points: [['Foton', 10], ['Videor', 0], ['Ljud', 2]] }, readLog);
  assertEquals(pie, { kind: 'pie', points: [{ label: 'Foton', value: 10 }, { label: 'Ljud', value: 2 }] });
  const slices = Array.from({ length: MAX_SLICES + 1 }, (_, index) => [`s${index}`, index + 1]);
  assertEquals((await chartFrom({ kind: 'pie', points: slices }, readLog))?.kind, 'bar');
});

Deno.test('numbers as the model writes them', () => {
  assertEquals(numberOf('82,5'), 82.5);
  assertEquals(numberOf('-3.25 °C'), -3.25);
  assertEquals(numberOf('1\u00a0204'), 1204);
  assertEquals(numberOf('ca 80'), undefined);
  assertEquals(numberOf(Number.NaN), undefined);
});

Deno.test('a JSON result too long for the model keeps its small fields, and the long list is what is cut', () => {
  const days = Array.from({ length: 2000 }, (_, index) => ({ key: `2015-01-${index}`, count: index }));
  const facets = { total: 68708, range: { min: 2015, max: 2020 }, days, years: [{ year: 2015, count: 14454 }, { year: 2016, count: 4748 }] };
  const handed = resultJson(facets);
  assertEquals(handed.length, 4000);
  assertStringIncludes(handed, '"years":[{"year":2015,"count":14454},{"year":2016,"count":4748}]');
  assert(handed.startsWith('{"total":68708,"range":'));
  // Under the limit, the result is as the command printed it.
  assertEquals(resultJson({ b: [1, 2, 3], a: 1 }), '{"b":[1,2,3],"a":1}');
});
