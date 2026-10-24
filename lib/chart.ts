/**
 * A chart card's query as the chart it draws (`/chart`, a card in the assistant's own drop-in).
 *
 * Two ways to say what to plot. `points` are values the model wrote itself, for a handful of them —
 * pictures per year it counted, three people's ages. `source` names a log, read as the viewer: the
 * model cannot copy a series of a hundred rows without moving values between them, and a chart of
 * a person's weight that is wrong in places is worse than none. Imports nothing, so the page can
 * use it.
 */

type ChartKind = 'line' | 'bar' | 'pie';

type ChartPoint = { label: string; value: number };

/** A chart as the kit's `Chart` draws it. */
export type ChartData = { kind: ChartKind; title?: string; unit?: string; points: ChartPoint[] };

/** More points than this are the log's, not the model's, and more than a chat bubble can show apart. */
const MAX_POINTS = 1000;
/** Points the model may write itself; past that it copies badly, and a log is the way. */
export const MAX_WRITTEN_POINTS = 60;
/** More slices than this is not a pie any more, and the palette has this many colours. */
export const MAX_SLICES = 8;
const MAX_LABEL = 40;

const KINDS: Record<string, ChartKind> = {
  line: 'line',
  area: 'line',
  bar: 'bar',
  column: 'bar',
  histogram: 'bar',
  pie: 'pie',
  donut: 'pie',
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const text = (value: unknown, max: number): string | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
};

/** A value as the model writes one: `82.5`, `"82,5"`, `"82.5 kg"`, `"1 204"`. */
export const numberOf = (value: unknown): number | undefined => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const match = /^\s*(-?[\d\s]*\d(?:[.,]\d+)?)/.exec(value.replace(/\u00a0/g, ' '));
  if (!match) return undefined;
  const parsed = Number(match[1].replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** One point the model wrote: `{label, value}`, `{x, y}`, `{date, value}` or `[label, value]`. */
const pointOf = (raw: unknown): ChartPoint | undefined => {
  if (Array.isArray(raw) && raw.length === 2) {
    const label = text(raw[0], MAX_LABEL);
    const value = numberOf(raw[1]);
    return label !== undefined && value !== undefined ? { label, value } : undefined;
  }
  const record = asRecord(raw);
  if (!record) return undefined;
  const label = text(record.label ?? record.x ?? record.date ?? record.name, MAX_LABEL);
  const value = numberOf(record.value ?? record.y ?? record.count);
  return label !== undefined && value !== undefined ? { label, value } : undefined;
};

/** The number in one log entry: the entry itself, the field asked for, `value`, or its only number. */
const entryValue = (data: unknown, field?: string): number | undefined => {
  if (typeof data === 'number') return Number.isFinite(data) ? data : undefined;
  const record = asRecord(data);
  if (!record) return undefined;
  if (field) return numberOf(record[field]);
  if (typeof record.value === 'number') return numberOf(record.value);
  const numbers = Object.values(record).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return numbers.length === 1 ? numbers[0] : undefined;
};

/**
 * A log as `cat -t` printed it — `<ISO time>\t<JSON>` a line — as points in time order, labelled by
 * day, or by minute where two entries share one. A log is written in the order entries arrived,
 * which for an imported one is not the order they happened.
 */
export const logPoints = (printed: string, field?: string): ChartPoint[] => {
  const entries: { at: string; value: number }[] = [];
  for (const line of printed.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const at = line.slice(0, tab).trim();
    if (Number.isNaN(Date.parse(at))) continue;
    let data: unknown;
    try {
      data = JSON.parse(line.slice(tab + 1));
    } catch {
      continue;
    }
    const value = entryValue(data, field);
    if (value !== undefined) entries.push({ at, value });
  }
  entries.sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
  const days = entries.map((entry) => entry.at.slice(0, 10));
  const count = new Map<string, number>();
  for (const day of days) count.set(day, (count.get(day) ?? 0) + 1);
  return entries.map((entry, index) => ({
    label: count.get(days[index])! > 1 ? entry.at.slice(0, 16).replace('T', ' ') : days[index],
    value: entry.value,
  }));
};

/**
 * The chart a card's query asks for, or nothing when there is nothing honest to draw.
 *
 * `readLog` gives a log as `cat -t` prints it, or nothing when the path is not a log the viewer can
 * read; `unitOf` looks up a log's own unit when the query gives none.
 */
export const chartFrom = async (
  raw: unknown,
  readLog: (path: string) => Promise<string | undefined>,
  unitOf: (path: string) => Promise<string | undefined> = () => Promise.resolve(undefined),
): Promise<ChartData | undefined> => {
  const record = asRecord(raw);
  if (!record) return undefined;
  const source = text(record.source, 1000);
  const kind = KINDS[String(record.kind ?? record.type ?? (source ? 'line' : 'bar')).trim().toLowerCase()];
  if (!kind) return undefined;
  let points: ChartPoint[];
  let unit = text(record.unit, 20);
  if (source) {
    const printed = await readLog(source.replace(/\/+$/, ''));
    if (printed === undefined) return undefined;
    points = logPoints(printed, text(record.field, 60)).slice(-MAX_POINTS);
    unit ??= await unitOf(source);
  } else {
    points = (Array.isArray(record.points) ? record.points : []).slice(0, MAX_WRITTEN_POINTS).map(pointOf).filter((point): point is ChartPoint => !!point);
  }
  let drawn = kind;
  if (kind === 'pie') {
    // A slice cannot be negative or nothing; too many are bars, which show every one of them.
    points = points.filter((point) => point.value > 0);
    if (points.length > MAX_SLICES) drawn = 'bar';
  }
  if (points.length < 2) return undefined;
  const title = text(record.title, 80);
  return { kind: drawn, ...(title ? { title } : {}), ...(unit ? { unit } : {}), points };
};
