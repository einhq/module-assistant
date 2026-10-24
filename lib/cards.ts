/**
 * The cards an answer may carry: what the installed modules offer to draw under it, and what the
 * model asked for.
 *
 * A module offers cards in its drop-in's `cards.json` (`/etc/assistant.d/<module>/cards.json`), a
 * list of `{ name, route, description, params, fill? }`: a route of its own, when it is wanted, and
 * a JSON Schema of the route's query. Each is offered to the model as an optional property of
 * `final_answer`, called `name`. What the model fills in becomes the route's query, checked first:
 * a path the asker cannot see is left out, and a card with a required value missing, or nothing at
 * all, is no card. The chat draws the route as a panel and the module's page fetches what it shows,
 * so nothing here knows what a card is.
 */

import type { Command } from '@ein/client';
import type { AssistantCard } from './api.ts';
import { dropInModules, readDropIn } from './drop-ins.ts';

/** Values in one list of a card's query; more than a card draws apart, and a URL can carry. */
const MAX_VALUES = 100;
const MAX_TEXT = 400;
/** `final_answer`'s own properties, which no card may take. */
const RESERVED = new Set(['answer', 'paths', 'links', 'table']);

type Schema = Record<string, unknown>;

/** A card as the model is offered it. */
export type CardOffer = {
  id: string;
  /** Its property in `final_answer`. */
  name: string;
  route: string;
  description: string;
  params: Schema;
  /** Parameters filled in when the model leaves them out: `pictures`, the paths of the answer's pictures. */
  fill: Record<string, string>;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** The cards the modules offer, module by module in name order, each in the order it lists them. */
export const loadCards = async (cmd: Command): Promise<CardOffer[]> => {
  const cards: CardOffer[] = [];
  for (const module of await dropInModules(cmd)) {
    const text = await readDropIn(cmd, module, 'cards.json');
    if (text === undefined) continue;
    let offered: unknown;
    try {
      offered = JSON.parse(text);
    } catch {
      continue;
    }
    for (const raw of Array.isArray(offered) ? offered : []) {
      const card = asRecord(raw);
      if (!card || typeof card.name !== 'string' || typeof card.route !== 'string') continue;
      const short = card.name.replace(/[^\w]/g, '_');
      // A name taken already, or one of final_answer's own, is the module's and the name.
      const name = RESERVED.has(short) || cards.some((other) => other.name === short) ? `${module}_${short}`.replace(/[^\w]/g, '_') : short;
      cards.push({
        id: `${module}.${card.name}`,
        name,
        route: card.route,
        description: typeof card.description === 'string' ? card.description : card.name,
        params: asRecord(card.params) ?? { type: 'object', properties: {} },
        fill: Object.fromEntries(Object.entries(asRecord(card.fill) ?? {}).filter(([, by]) => typeof by === 'string')) as Record<string, string>,
      });
    }
  }
  return cards;
};

/** A card as a property of `final_answer`: its parameters, described by when it is wanted. */
export const cardProperty = (card: CardOffer): Schema => ({ ...card.params, type: 'object', description: card.description });

/** A list as a model writes one: a list, its JSON text, or one value. */
const listOf = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* one value */ }
    return value.trim() ? [value] : [];
  }
  return value === undefined || value === null ? [] : [value];
};

const isPath = (schema: Schema | undefined): boolean => schema?.format === 'path';

/** One scalar as its schema takes it, or nothing. */
const scalarOf = async (value: unknown, schema: Schema | undefined, visible: (path: string) => Promise<boolean>): Promise<string | undefined> => {
  if (value === undefined || value === null || typeof value === 'object') return undefined;
  const text = String(value).trim().slice(0, MAX_TEXT);
  if (!text) return undefined;
  if (schema?.type === 'number' || schema?.type === 'integer') return Number.isFinite(Number(text)) ? text : undefined;
  if (!isPath(schema)) return text;
  const path = text.replace(/\/+$/, '');
  return path.startsWith('/') && await visible(path) ? path : undefined;
};

/**
 * The card the model asked for, as its route with the query its arguments make, or nothing.
 *
 * `visible` says whether the asker can see a path; `pictures` are the paths of the pictures the
 * answer shows, for a parameter the card fills with them. A scalar is one query value, a list of
 * scalars one value each, and anything else its JSON, which the card's page reads back.
 */
export const cardFrom = async (
  card: CardOffer,
  raw: unknown,
  visible: (path: string) => Promise<boolean>,
  pictures: string[],
): Promise<AssistantCard | undefined> => {
  // `map: true` asks for the card with nothing named, as `map: {}` does.
  const given = raw === true ? {} : asRecord(raw);
  if (!given) return undefined;
  const properties = asRecord(card.params.properties) ?? {};
  const query = new URLSearchParams();
  for (const [key, schemaValue] of Object.entries(properties)) {
    const schema = asRecord(schemaValue);
    let value = given[key];
    if ((value === undefined || listOf(value).length === 0) && card.fill[key] === 'pictures' && pictures.length) value = pictures;
    if (value === undefined) continue;
    if (schema?.type === 'array') {
      const items = asRecord(schema.items);
      if (items?.type === 'object' || items?.type === 'array') {
        const list = listOf(value).slice(0, MAX_VALUES);
        if (list.length) query.set(key, JSON.stringify(list));
        continue;
      }
      for (const item of listOf(value).slice(0, MAX_VALUES)) {
        const one = await scalarOf(item, items, visible);
        if (one !== undefined && !query.getAll(key).includes(one)) query.append(key, one);
      }
    } else if (schema?.type === 'object') {
      if (asRecord(value)) query.set(key, JSON.stringify(value));
    } else {
      const one = await scalarOf(value, schema ?? undefined, visible);
      if (one !== undefined) query.set(key, one);
    }
  }
  const required = Array.isArray(card.params.required) ? card.params.required.map(String) : [];
  if (required.some((key) => !query.has(key)) || [...query.keys()].length === 0) return undefined;
  return { id: card.id, route: `${card.route}${card.route.includes('?') ? '&' : '?'}${query}` };
};
