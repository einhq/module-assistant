/**
 * The links in a Markdown answer, kept only where they lead somewhere.
 *
 * The drawer renders the model's answer as Markdown, and a link to an archive path there is a way
 * into the app. The model writes those paths from what its commands printed — but it can also
 * write one it made up, and a link that opens nothing, or someone else's private node, is worse
 * than none. So a path link survives only when the node exists and the asker can see it; any
 * other becomes its own words. Each one kept comes back with its node's type, which the chat opens
 * it by. Web links are left for the drawer, which opens them in a new tab.
 *
 * The answer is parsed with the same Markdown parser the drawer's renderer is built on, so a link
 * here is exactly a link there — inline, by reference, inside a table or a list — and only the
 * link's own source is rewritten; the rest of the answer is kept byte for byte.
 */

import { fromMarkdown } from 'mdast-util-from-markdown';

type MdNode = {
  type: string;
  url?: string;
  identifier?: string;
  children?: MdNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};

/** How many distinct paths one answer may have checked; past that, a link is its words. */
const MAX_CHECKED = 50;

const walk = (node: MdNode, visit: (node: MdNode) => void) => {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
};

const decoded = (url: string): string => {
  try {
    return decodeURI(url);
  } catch {
    return url;
  }
};

export const keepKnownLinks = async (
  text: string,
  typeOf: (path: string) => Promise<string | undefined>,
): Promise<{ text: string; types: Record<string, string> }> => {
  const types: Record<string, string> = {};
  if (!text.includes('](') && !text.includes(']:')) return { text, types };
  const tree = fromMarkdown(text) as MdNode;
  const definitions = new Map<string, MdNode>();
  walk(tree, (node) => {
    if (node.type === 'definition' && node.identifier) definitions.set(node.identifier, node);
  });

  const verdicts = new Map<string, string | undefined>();
  const known = async (url: string): Promise<boolean> => {
    if (!url.startsWith('/')) return true;
    const path = decoded(url).split(/[?#]/)[0];
    if (!verdicts.has(path)) verdicts.set(path, verdicts.size < MAX_CHECKED ? await typeOf(path) : undefined);
    const type = verdicts.get(path);
    if (type !== undefined) types[path.replace(/\/+$/, '')] = type;
    return type !== undefined;
  };

  // Source ranges to replace, and what with: a link by its words, a dead definition by nothing.
  const edits: { start: number; end: number; with: string }[] = [];
  const linkNodes: MdNode[] = [];
  walk(tree, (node) => {
    if (node.type === 'link' || node.type === 'linkReference' || node.type === 'definition') linkNodes.push(node);
  });
  for (const node of linkNodes) {
    const url = node.type === 'linkReference' ? definitions.get(node.identifier ?? '')?.url : node.url;
    if (url === undefined || await known(url)) continue;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    const children = node.children ?? [];
    const first = children[0]?.position?.start.offset;
    const last = children[children.length - 1]?.position?.end.offset;
    const words = first !== undefined && last !== undefined ? text.slice(first, last) : '';
    edits.push({ start, end, with: node.type === 'definition' ? '' : words });
  }
  let out = text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, edit.start) + edit.with + out.slice(edit.end);
  return { text: out, types };
};
