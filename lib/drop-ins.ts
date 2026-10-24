/**
 * What modules give the assistant: each module's `etc/assistant.d/`, which `mod setup` links as
 * `/etc/assistant.d/<module>/`. The assistant reads these and names no module itself.
 */

import type { Command } from '@ein/client';
import { shq } from '@ein/client';

/** Where the drop-ins are. */
const DROP_INS = '/etc/assistant.d';

/** The modules that give the assistant something, in name order. */
export const dropInModules = async (cmd: Command): Promise<string[]> => {
  try {
    return (await cmd.sys.vfs.children(cmd.access, DROP_INS)).map((child) => child.name).sort();
  } catch {
    return [];
  }
};

/** One file of a module's drop-in, or nothing when it gives none. */
export const readDropIn = async (cmd: Command, module: string, file: string): Promise<string | undefined> => {
  const ran = await cmd.execute(`cat ${shq(`${DROP_INS}/${module}/${file}`)}`);
  return ran.code === 0 ? `${ran.stdout ?? ''}` : undefined;
};

/** The commands the modules offer the model as tools (`tools`: one a line, `#` a comment), in module order, each once. */
export const offeredTools = async (cmd: Command): Promise<string[]> => {
  const names: string[] = [];
  for (const module of await dropInModules(cmd)) {
    for (const line of (await readDropIn(cmd, module, 'tools') ?? '').split('\n')) {
      const name = line.replace(/#.*/, '').trim();
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names;
};

/** What the modules tell the model about their part (`prompt.md`), in module order. */
export const modulePrompts = async (cmd: Command): Promise<string[]> => {
  const texts: string[] = [];
  for (const module of await dropInModules(cmd)) {
    const text = (await readDropIn(cmd, module, 'prompt.md'))?.trim();
    if (text) texts.push(text);
  }
  return texts;
};

/** Questions the modules suggest asking (`examples`: one a line, `#` a comment), in module order. */
export const suggestedQuestions = async (cmd: Command): Promise<string[]> => {
  const questions: string[] = [];
  for (const module of await dropInModules(cmd)) {
    for (const line of (await readDropIn(cmd, module, 'examples') ?? '').split('\n')) {
      const question = line.replace(/^#.*/, '').trim();
      if (question) questions.push(question);
    }
  }
  return questions;
};
