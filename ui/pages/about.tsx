import { Skeleton } from '@mantine/core';
import { StatTile } from '@ein/ui/components';
import { usePolledCommand } from '@ein/ui/hooks';
import type { LlmStatus } from '@assistant/api';

const WHERE = { card: 'on the card', cpu: 'on the CPU' } as const;

/**
 * The chat's language model on the About dialog (`assistant.about`, an `about.services` panel in the
 * assistant's `nav.json`), from `llm-status`: the model, and whether it runs on this host and where,
 * or is a provider's.
 */
export default function LanguageModelAbout() {
  const { data, error } = usePolledCommand<LlmStatus>('llm-status');
  if (!data && !error) return <Skeleton height={86} radius='md' />;
  if (!data) return null;

  const hint = data.kind === 'external' ? `${data.provider}'s, outside this host` : ['on this host', data.card && WHERE[data.card]].filter(Boolean).join(', ');
  return <StatTile label='Language model' value={data.model} hint={hint} accent='#da77f2' tooltip={data.url} />;
}
