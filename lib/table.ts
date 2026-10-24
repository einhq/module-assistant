/**
 * A command's output as the table under an answer (`final_answer`'s `table`): the model names the
 * line, the code reads the rows. The 4B model cannot copy a hundred rows without moving values
 * between them, and a table of a log that is wrong in places is worse than none.
 *
 * JSON — what EiN's commands print in JSON mode — is a row per object of a list, or of the longest
 * list of objects in an object (a search's `results`), and a column per field; a lone object is a
 * row per field. Text is a row per line and a cell per tab-separated part, where a part that is a
 * JSON object is a column per field: `cat -t` of a log is its time, then each entry's fields.
 */

import type { AssistantTable } from './api.ts';

/** Rows past this are counted, not shown: more than a chat reads, and the stored message carries them all. */
const MAX_ROWS = 1000;
/** Columns past this are left out: a drawer is narrow, and a command's JSON has many fields. */
const MAX_COLUMNS = 12;
const MAX_CELL = 200;

type Row = Map<string, unknown>;

const ISO_TIME = /^(\d{4}-\d\d-\d\d)T(\d\d:\d\d)(:\d\d)?(\.\d+)?(Z|[+-]\d\d:?\d\d)?$/;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** A value as a cell: a time as its day when it is midnight, else to the second; anything nested as its JSON. */
const cellOf = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  let text = typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
  const time = ISO_TIME.exec(text);
  if (time) text = time[2] === '00:00' && (!time[3] || time[3] === ':00') ? time[1] : `${time[1]} ${time[2]}${time[3] ?? ''}`;
  return text.length > MAX_CELL ? `${text.slice(0, MAX_CELL - 1)}…` : text;
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** The rows of JSON output, or nothing for a value that is no table. */
const jsonRows = (value: unknown): Row[] | undefined => {
  if (Array.isArray(value)) {
    return value.map((item) => {
      const record = asRecord(item);
      return new Map(record ? Object.entries(record) : [['', item]]);
    });
  }
  const record = asRecord(value);
  if (!record) return undefined;
  const lists = Object.values(record).filter((field): field is unknown[] => Array.isArray(field) && field.length > 0 && field.every((item) => asRecord(item)));
  if (lists.length) return jsonRows(lists.reduce((longest, list) => list.length > longest.length ? list : longest));
  return Object.entries(record).map(([key, field]) => new Map([['field', key], ['value', field]]));
};

/** The rows of text output: a line each, split at tabs, an object part spread into its fields. */
const textRows = (text: string): Row[] =>
  text.split('\n').filter((line) => line.trim()).map((line) => {
    const row: Row = new Map();
    line.split('\t').forEach((part, index) => {
      const object = part.trimStart().startsWith('{') ? asRecord(parseJson(part)) : undefined;
      if (object) { for (const [key, value] of Object.entries(object)) row.set(key, value); }
      else row.set(`#${index}`, part);
    });
    return row;
  });

/**
 * The table a command printed, or nothing when it printed nothing to tabulate. `columns`, when
 * given, picks the ones to show, in that order, by name; one that matches none is left out.
 */
export const tableFrom = (output: string, line: string, options: { title?: string; columns?: string[] } = {}): AssistantTable | undefined => {
  const trimmed = output.trim();
  if (!trimmed) return undefined;
  const json = /^[[{]/.test(trimmed) ? parseJson(trimmed) : undefined;
  const rows = (json !== undefined ? jsonRows(json) : undefined) ?? textRows(trimmed);
  if (!rows.length) return undefined;
  let keys = [...new Set(rows.flatMap((row) => [...row.keys()]))];
  const asked = (options.columns ?? []).map((name) => keys.find((key) => key.toLowerCase() === name.trim().toLowerCase())).filter((key): key is string => !!key);
  keys = (asked.length ? [...new Set(asked)] : keys).slice(0, MAX_COLUMNS);
  // A text part has no name, unless every row has a time there.
  const columns = keys.map((key) => !key.startsWith('#') ? key : rows.every((row) => ISO_TIME.test(String(row.get(key) ?? ''))) ? 'time' : '');
  const shown = rows.slice(0, MAX_ROWS).map((row) => keys.map((key) => cellOf(row.get(key))));
  return {
    line,
    ...(options.title ? { title: options.title } : {}),
    columns,
    rows: shown,
    ...(rows.length > MAX_ROWS ? { more: rows.length - MAX_ROWS } : {}),
  };
};

/** A line of a list or of a Markdown table: a bullet, a number, or a cell border first. */
const LIST_LINE = /^\s*(?:(?:[-*+•]|\d+[.)])\s|\|)/;

/**
 * The reply that goes above a table, without the lists the model wrote into it anyway. Those copy
 * the table's rows, and the model gets them wrong: values moved between rows, rows left out or made
 * up. The words around a list stay.
 */
export const withoutRows = (answer: string): string => answer.split('\n').filter((line) => !LIST_LINE.test(line)).join('\n').replace(/\n{3,}/g, '\n\n').trim();

/** How many lines of the reply are a list's or a Markdown table's. */
export const listLines = (answer: string): number => answer.split('\n').filter((line) => LIST_LINE.test(line)).length;
