import { routeForNode } from '../lib/assistant.ts';
import { Markdown } from '@ein/ui/components';

/** A link target as a path: the model may write it percent-encoded or not. */
const pathOf = (href: string): string => {
  try {
    return decodeURI(href);
  } catch {
    return href;
  }
};

/**
 * Where a reply's link may go: a path — what its commands gave it — is that node's page in the app,
 * by the type the assistant found it to be (`types`); a web address opens in a new tab; anything
 * else is left as text, because a made-up link that leads nowhere is worse than none.
 */
const replyLink = (types: Record<string, string>) => (href: string): string | null | undefined => {
  if (href.startsWith('/')) {
    const path = pathOf(href).split(/[?#]/)[0].replace(/\/+$/, '');
    return types[path] ? routeForNode(types[path], path) ?? null : null;
  }
  return /^(https?|mailto):/i.test(href) ? undefined : null;
};

/**
 * An assistant reply, rendered as Markdown: lists, emphasis, tables, code. Images are never
 * loaded: the reply's pictures come as cards, and a model-written image URL would fetch from
 * wherever it says.
 */
export function ChatMarkdown({ content, types = {} }: { content: string; types?: Record<string, string> }) {
  return <Markdown className='mrx-chat-markdown' content={content} link={replyLink(types)} />;
}
