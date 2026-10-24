/**
 * Core's `search` as the assistant runs it outside the model's own calls: the command line a
 * filter set becomes, and the pictures it answers.
 */

import type { Command } from '@ein/client';
import { shq } from '@ein/client';
import type { MediaHit, Seen } from './reply.ts';
import type { SearchFilters } from './api.ts';
export type { SearchFilters } from './api.ts';

export const MAX_LIMIT = 24;

class SearchError extends Error {}

const runJson = async (cmd: Command, script: string): Promise<{ code: number; data: unknown }> => {
  const result = await cmd.execute(`JSON_OUTPUT=1 ${script}`);
  let data: unknown = null;
  try {
    data = result.stdout.trim() ? JSON.parse(result.stdout) : null;
  } catch {
    data = null;
  }
  if (result.code !== 0 && data === null) {
    throw new SearchError(result.stderr.trim().split('\n').pop() || `command failed (${result.code})`);
  }
  return { code: result.code, data };
};

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const str = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined;
const num = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const slugOfPath = (path: string): string => path.split('/').filter(Boolean).pop() ?? path;

export const hitFrom = (raw: unknown): MediaHit | undefined => {
  const hit = asRecord(raw);
  const path = str(hit.path);
  if (!path) return undefined;
  return {
    path,
    name: str(hit.name) ?? slugOfPath(path),
    ...(str(hit.kind) ? { kind: hit.kind as string } : {}),
    ...(str(hit.mimetype) ? { mimetype: hit.mimetype as string } : {}),
    ...(str(hit.takenAt) ? { takenAt: hit.takenAt as string } : {}),
    ...(str(hit.takenAtUtc) ? { takenAtUtc: hit.takenAtUtc as string } : {}),
    ...(num(hit.width) !== undefined ? { width: hit.width as number } : {}),
    ...(num(hit.height) !== undefined ? { height: hit.height as number } : {}),
    ...(num(hit.angle) !== undefined ? { angle: hit.angle as number } : {}),
    ...(num(hit.sar) !== undefined ? { sar: hit.sar as number } : {}),
    ...(num(hit.duration) !== undefined ? { duration: hit.duration as number } : {}),
    ...(str(hit.description) ? { description: hit.description as string } : {}),
  };
};

/**
 * How many rows a search may examine before it stops and calls the answer truncated. Above the
 * command's default, which bounds a search box's latency: a person with tens of thousands of
 * pictures asked about one country needs them all scanned, and a chat answer is allowed the
 * seconds that costs — a count especially, since "how many times" over a partial scan is wrong.
 */
const PAGE_MAX_SCAN = 20000;

/** The search command line for a validated filter set, shared with the UI-facing `search` field. */
export const searchCommand = (filters: SearchFilters, limit: number, from?: string, to?: string, maxScan = PAGE_MAX_SCAN): string => {
  const parts = ['search'];
  if (filters.query) parts.push(shq(filters.query));
  if (filters.kinds?.length) parts.push(`--kind ${filters.kinds.join(',')}`);
  for (const subject of filters.subjects ?? []) parts.push(`--subject ${shq(subject)}`);
  for (const name of filters.subjectNames ?? []) parts.push(`--subject-name ${shq(name)}`);
  // `=` form: a box west of Greenwich or south of the equator has negative numbers in it.
  if (filters.region) parts.push(`--bbox=${[filters.region.north, filters.region.south, filters.region.east, filters.region.west].join(',')}`);
  if (from) parts.push(`--from ${from}`);
  if (to) parts.push(`--to ${to}`);
  if (filters.like) parts.push(`--like ${shq(filters.like)}`);
  if (filters.sort) parts.push(`--sort=${filters.sort}`);
  parts.push(`-l ${limit}`, `--max-scan ${maxScan}`, '--fields description');
  return parts.join(' ');
};

/**
 * Run one search command line and answer its hits, and the subjects it resolved, in order.
 *
 * `more` is "there is a next page": the command filled its page before the filters were done
 * (`truncated`), gave a cursor, or found more than `limit`. Pictures the conversation has
 * already shown (`seen.shown`) are dropped: "fler bilder" is the same search again, and the
 * caller has asked for a page big enough to have new ones left after the drop (`pageFor`). The
 * page is then cut to `limit`.
 */
export const searchHits = async (
  cmd: Command,
  script: string,
  seen: Seen,
  limit: number,
): Promise<{ hits: MediaHit[]; more: boolean; subjects: { kind: string; path: string }[] }> => {
  const { data } = await runJson(cmd, script);
  const result = asRecord(data);
  const all = asArray(result.results).map(hitFrom).filter((hit) => hit !== undefined);
  const fresh = all.filter((hit) => !seen.shown.has(hit.path));
  const hits = fresh.slice(0, limit);
  const beyond = result.truncated === true || (typeof result.cursor === 'string' && result.cursor !== '') || fresh.length > hits.length;
  const subjects = asArray(asRecord(result.filters).subjects).map(asRecord).flatMap((subject) =>
    typeof subject.kind === 'string' && typeof subject.path === 'string' ? [{ kind: subject.kind, path: subject.path }] : []
  );
  return { hits, more: hits.length > 0 && beyond, subjects };
};

/** The page to ask the command for: the page wanted, plus room for what has been shown already. */
export const pageFor = (limit: number, seen: Seen): number => Math.min(SEARCH_PAGE_MAX, limit + seen.shown.size);

/**
 * The most rows one chat search asks for — `search`'s own page ceiling. A conversation that has
 * shown more than that may see an early picture again on a very long "fler"; the alternative
 * is paging with a cursor the browser would have to keep, for a case nobody has hit.
 */
const SEARCH_PAGE_MAX = 200;
