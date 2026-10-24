/**
 * The assistant's prompt: the system message and how each user message is stamped.
 *
 * The model calls the commands the modules offer as native tools, so the schemas carry what each call takes
 * and nothing here repeats it in prose. The prompt text itself is a file an operator can edit
 * (`COMMANDS_PROMPT_PATH`); this code adds only what is true of one request.
 */

import type { AssistantContext } from './api.ts';

/** Who is asking, when the account is linked to a person, and where their files go. */
type Asker = {
  /** The person the account is linked to: their name and node. */
  user?: { name: string; path: string };
  /** The user's home directory, where a file they ask for with no path goes. */
  home?: string;
};

/** Where the prompt file is installed. */
export const COMMANDS_PROMPT_PATH = '/etc/assistant-prompt.md';

/**
 * The system message: the prompt file as written, then what is true of this request.
 *
 * The text lives in `/etc/assistant-prompt.md` (shipped as `modules/assistant/etc/`, copied once by
 * `mod setup` and never replaced), so whoever runs the instance can edit it without a release. It
 * therefore carries nothing that changes between requests; who the user is comes after it, and the
 * time and what the app shows travel with each user message (`stampedMessage`). That keeps the
 * system message the same for a whole chat, which a session needs, and everything before CONTEXT —
 * Qwen3.5's template writes the tools first, then its format block, then this text — the same for
 * every chat, which the shared snapshot needs.
 */
export const commandsSystem = (prompt: string, context: Asker): string => {
  const lines = [
    'Each user message starts with a bracket saying when it was sent and what the app was showing: that is the current time and place; nothing else in the conversation is.',
    '"on screen" in it is the app screen the user has open beside this chat: its name, what it says it shows, how it is set (?tab=family), and the node it is about when it is about one. "This page", "what I am looking at" — Swedish "den här sidan", "det jag tittar på" — mean that screen. A screen is part of the app, not a node: never ls, stat, cat or find its name. Its node, when given, is a path like any other.',
  ];
  if (context.user) {
    const slug = context.user.path.split('/').filter(Boolean).pop();
    lines.push(
      `The user is ${context.user.name}, the person ${context.user.path} (slug "${slug}"). "I", "me", "my", "we", "us" — Swedish "jag", "mig", "min", "mitt", "vi", "oss" — mean this person: use that path or slug directly, never look them up.`,
    );
  } else lines.push('The user is not linked to a person: "I" and "we" cannot be resolved; say so if it matters.');
  if (context.home) lines.push(`The user's home directory is ${context.home}; a file they name with no path goes there.`);
  return `${prompt.trim()}\n\nCONTEXT:\n${lines.join('\n')}`;
};

/**
 * A user message as the loop sends it: stamped with when it was sent and what the app was
 * showing. These change with every message, so they travel with it rather than in the system text,
 * which would otherwise differ on every call and never let a session continue. The stamp is made
 * from what the chat log stores (the message's own time), so a rebuilt conversation says exactly
 * what it said the first time.
 */
export const stampedMessage = (content: string, at: Date, shown: AssistantContext = {}): string => {
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][at.getDay()];
  const when = `${day} ${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return `[${[when, pageOf(shown), shown.lightbox && `open picture ${shown.lightbox}`].filter(Boolean).join(' · ')}] ${content}`;
};

/**
 * The page in a stamp, in words:
 * `on screen: People › Anna Andersson, "Born 1985", ?tab=family, about node /archive/people/Anna_Andersson`.
 * A named page goes without its address, which the model would take for a node path and look for;
 * only the query, which says how the page is set, is kept.
 */
const pageOf = ({ route, section, title, about, node }: AssistantContext): string | undefined => {
  if (!route && !title && !node) return undefined;
  const name = [...new Set([section, title].filter(Boolean))].join(' › ');
  const query = route?.match(/\?[^#]+/)?.[0];
  const screen = name ? `on screen: ${name}` : route ? `on screen: web address ${route}` : 'on screen';
  return [screen, about && `"${about}"`, name && query, node && `about node ${node}`].filter(Boolean).join(', ');
};
