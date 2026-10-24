import { assertEquals } from '@std/assert';
import { tableFrom, withoutRows } from '@assistant/table';

Deno.test('a log as cat -t prints it: its time, then each entry’s fields', () => {
  const printed = '2012-04-10T00:00:00.000Z\t{"value":83.4}\n2012-04-11T07:30:00.000Z\t{"value":82.4,"note":"morgon"}\n';
  assertEquals(tableFrom(printed, 'cat -t /w'), {
    line: 'cat -t /w',
    columns: ['time', 'value', 'note'],
    rows: [['2012-04-10', '83.4', ''], ['2012-04-11 07:30:00', '82.4', 'morgon']],
  });
});

Deno.test('a JSON list is a row per object, and a list in an object is its longest list of objects', () => {
  const services = { total: 2, services: [{ name: 'a', state: 'running' }, { name: 'b', state: 'failed', pid: 7 }], tags: [{ x: 1 }] };
  assertEquals(tableFrom(JSON.stringify(services), 'service-list'), {
    line: 'service-list',
    columns: ['name', 'state', 'pid'],
    rows: [['a', 'running', ''], ['b', 'failed', '7']],
  });
  assertEquals(tableFrom('[1,2]', 'x')?.rows, [['1'], ['2']]);
});

Deno.test('a lone object is a row per field, anything nested as its JSON', () => {
  assertEquals(tableFrom('{"name":"weight","attrs":{"unit":"kg"}}', 'stat /w'), {
    line: 'stat /w',
    columns: ['field', 'value'],
    rows: [['name', 'weight'], ['attrs', '{"unit":"kg"}']],
  });
});

Deno.test('plain text is a row per line, a cell per tab, with no names', () => {
  assertEquals(tableFrom('a\t1\n\nb\t2\n', 'x'), { line: 'x', columns: ['', ''], rows: [['a', '1'], ['b', '2']] });
});

Deno.test('the columns asked for, in that order; none that match leaves them all', () => {
  const json = JSON.stringify([{ name: 'a', state: 'running', pid: 1 }]);
  assertEquals(tableFrom(json, 'x', { columns: ['PID', 'name', 'nothing'] })?.columns, ['pid', 'name']);
  assertEquals(tableFrom(json, 'x', { columns: ['nothing'] })?.columns, ['name', 'state', 'pid']);
});

Deno.test('rows past a thousand are counted, not shown; nothing printed is no table', () => {
  const table = tableFrom(Array.from({ length: 1005 }, (_, i) => `row ${i}`).join('\n'), 'x', { title: 'T' })!;
  assertEquals([table.title, table.rows.length, table.more, table.rows.at(-1)], ['T', 1000, 5, ['row 999']]);
  assertEquals(tableFrom('  \n', 'x'), undefined);
});

Deno.test('the reply above a table keeps its words and loses the rows it copied', () => {
  const answer = 'Här är etiketterna:\n\n- **segling**: 79\n- jul: 43\n* påsk\n1. nyår\n2) kalas\n| a | b |\n|---|---|\n\nVill du se någon av dem?';
  assertEquals(withoutRows(answer), 'Här är etiketterna:\n\nVill du se någon av dem?');
  assertEquals(withoutRows('-5 grader var kallast.\n2024 var året.'), '-5 grader var kallast.\n2024 var året.');
});
