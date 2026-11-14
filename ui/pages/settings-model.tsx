import { Alert, Anchor, Autocomplete, Group, Paper, PasswordInput, Radio, SimpleGrid, Skeleton, Stack, Text, TextInput } from '@mantine/core';
import { useEffect, useMemo, useState } from 'react';
import type { ConfigEntry, ConfigWriteAnswer, HealthCheck } from '@ein/api';
import { SaveBar, settingOf, TablerIcon, useViewSave } from '@ein/ui/components';
import { useCommand, useConfig } from '@ein/ui/hooks';

/** A provider offered by name: where its API is, the models suggested before its own list is read, and where its keys are made. */
type Preset = { id: string; provider: string; url: string; models: string[]; keys: string };

/** Hosted providers whose chat API the assistant speaks, as their addresses are without `/v1`. */
const PRESETS: Preset[] = [
  {
    id: 'anthropic',
    provider: 'Anthropic',
    url: 'https://api.anthropic.com',
    models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
    keys: 'https://platform.claude.com/settings/keys',
  },
  { id: 'openai', provider: 'OpenAI', url: 'https://api.openai.com', models: ['gpt-5', 'gpt-5-mini'], keys: 'https://platform.openai.com/api-keys' },
  {
    id: 'mistral',
    provider: 'Mistral AI',
    url: 'https://api.mistral.ai',
    models: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest'],
    keys: 'https://console.mistral.ai/api-keys',
  },
];

const OURS = 'ours';
const OTHER = 'other';

const KEYS = ['CFG_LLM_PROVIDER', 'CFG_LLM_URL', 'CFG_LLM_MODEL', 'CFG_LLM_KEY'];

/** An address as the assistant reads it: no trailing `/` or `/v1`. */
const baseOf = (url: string): string => url.trim().replace(/\/+$/, '').replace(/\/v1$/, '');

/** Which choice the settings in force are: ours when no provider is named, a preset by its address, or another service. */
const choiceOf = (provider: string, url: string): string => (provider.trim() ? PRESETS.find((preset) => preset.url === baseOf(url))?.id ?? OTHER : OURS);

type Draft = { choice: string; provider: string; url: string; model: string; key: string };

/** A health check as a line with its mark. */
function Check({ check }: { check: HealthCheck }) {
  const ok = check.state === 'ok';
  return (
    <Group gap='xs' wrap='nowrap' align='flex-start'>
      {ok
        ? <TablerIcon name='circle-check' size={18} color='var(--mantine-color-green-6)' />
        : <TablerIcon name='alert-triangle' size={18} color='var(--mantine-color-yellow-6)' />}
      <Text size='sm'>{check.reason}</Text>
    </Group>
  );
}

/**
 * The language model, a settings view of the assistant's (`assistant.model`, a `settings.views`
 * panel): who answers the chat — this machine's model, a provider chosen by name, or another
 * service that speaks the OpenAI chat API — with its key and model, saved as one
 * (`CFG_LLM_PROVIDER`, `_URL`, `_MODEL`, `_KEY`), and then whether it answers (`llm-status
 * --checks`). A provider's own list of models (`llm-status --models`) is offered once its key is in.
 */
export default function LanguageModelSettings() {
  const config = useConfig('system');
  const checks = useCommand<HealthCheck[]>('llm-status --checks');
  const offered = useCommand<string[]>('llm-status --models');
  const save = useViewSave();
  const entry = (key: string): ConfigEntry | undefined => settingOf(config.entries, key);
  const provider = entry('CFG_LLM_PROVIDER');
  const url = entry('CFG_LLM_URL');
  const model = entry('CFG_LLM_MODEL');
  const key = entry('CFG_LLM_KEY');

  const saved = useMemo<Draft | undefined>(() => {
    if (!provider || !url || !model) return undefined;
    return { choice: choiceOf(provider.value, url.value), provider: provider.value, url: url.value, model: model.value, key: '' };
  }, [provider?.value, url?.value, model?.value]);
  const [draft, setDraft] = useState<Draft | undefined>(saved);
  useEffect(() => setDraft(saved), [saved]);

  if (config.loading) return <Skeleton height={320} radius='md' />;
  if (!saved || !key) return <Text c='dimmed'>{config.error?.message ?? 'The language model settings did not load.'}</Text>;
  if (!draft) return <Skeleton height={320} radius='md' />;

  const preset = PRESETS.find((each) => each.id === draft.choice);
  const ours = draft.choice === OURS;
  const sameService = draft.choice === saved.choice && baseOf(draft.url) === baseOf(saved.url);
  const keySet = key.source !== 'default';
  const dirty = draft.choice !== saved.choice || draft.provider !== saved.provider || baseOf(draft.url) !== baseOf(saved.url) || draft.model !== saved.model ||
    draft.key !== '';

  const choose = (choice: string) => {
    save.clear();
    if (choice === saved.choice) return setDraft(saved);
    const chosen = PRESETS.find((each) => each.id === choice);
    setDraft({
      choice,
      provider: chosen?.provider ?? '',
      url: chosen?.url ?? '',
      model: chosen?.models[0] ?? '',
      key: '',
    });
  };
  const change = (next: Partial<Draft>) => {
    save.clear();
    setDraft({ ...draft, ...next });
  };

  // A key goes only where it was given for: a new service without its own would be sent the old one.
  const keyFromDeployment = key.source === 'environment';
  const blocked = ours && provider?.source === 'environment'
    ? `The installation names ${provider.value} in its .env; this machine's model answers once that is removed.`
    : !ours && !sameService && keyFromDeployment && !draft.key
    ? "The key in the installation's .env belongs to the service it names there; give this one its own key."
    : !ours && (!draft.provider.trim() || !draft.url.trim() || !draft.model.trim())
    ? 'Name the service, its address and the model.'
    : preset && !draft.key && !(sameService && keySet)
    ? `Paste the key ${preset.provider} gave you.`
    : undefined;

  const write = async (): Promise<ConfigWriteAnswer[]> => {
    if (ours) return [await config.resetAll(KEYS)];
    const answers = [
      await config.saveAll({
        CFG_LLM_PROVIDER: draft.provider.trim(),
        CFG_LLM_URL: baseOf(draft.url),
        CFG_LLM_MODEL: draft.model.trim(),
        ...(draft.key ? { CFG_LLM_KEY: draft.key } : {}),
      }),
    ];
    // Another service without a key of its own: the one set here was the old service's.
    if (!sameService && !draft.key && key.source === 'system') answers.push(await config.resetAll(['CFG_LLM_KEY']));
    return answers;
  };
  const onSave = async () => {
    if (await save.run(write)) setDraft((current) => current && { ...current, key: '' });
    checks.refetch();
    offered.refetch();
  };

  const models = sameService && offered.data?.length ? offered.data : preset?.models ?? [];

  return (
    <Stack gap='lg'>
      <Radio.Group value={draft.choice} onChange={choose} label='Who answers the chat'>
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing='sm' mt='xs'>
          <Radio.Card value={OURS} p='md' radius='md' disabled={save.busy}>
            <Group wrap='nowrap' align='flex-start'>
              <Radio.Indicator />
              <div>
                <Text fw={600}>This machine</Text>
                <Text size='sm' c='dimmed'>The model setup.sh --llm runs beside EiN. Nothing leaves the machine.</Text>
              </div>
            </Group>
          </Radio.Card>
          {PRESETS.map((each) => (
            <Radio.Card key={each.id} value={each.id} p='md' radius='md' disabled={save.busy}>
              <Group wrap='nowrap' align='flex-start'>
                <Radio.Indicator />
                <div>
                  <Text fw={600}>{each.provider}</Text>
                  <Text size='sm' c='dimmed'>Its models, with a key from your {each.provider} account.</Text>
                </div>
              </Group>
            </Radio.Card>
          ))}
          <Radio.Card value={OTHER} p='md' radius='md' disabled={save.busy}>
            <Group wrap='nowrap' align='flex-start'>
              <Radio.Indicator />
              <div>
                <Text fw={600}>Another service</Text>
                <Text size='sm' c='dimmed'>Any that speaks the OpenAI chat API: a provider, or a server of your own such as Ollama.</Text>
              </div>
            </Group>
          </Radio.Card>
        </SimpleGrid>
      </Radio.Group>

      {!ours && (
        <Paper p='md' radius='md' withBorder>
          <Stack gap='sm'>
            {draft.choice === OTHER && (
              <>
                <TextInput
                  label='Name'
                  description='What the chat calls the service when it says where questions go.'
                  placeholder='Example AI'
                  value={draft.provider}
                  disabled={save.busy}
                  onChange={(event) => change({ provider: event.currentTarget.value })}
                />
                <TextInput
                  label='Address'
                  description='The API without /v1, such as https://api.example.com or http://192.168.1.20:11434.'
                  value={draft.url}
                  disabled={save.busy}
                  onChange={(event) => change({ url: event.currentTarget.value })}
                />
              </>
            )}
            <PasswordInput
              label='Key'
              description={preset
                ? (
                  <>
                    Made under <Anchor href={preset.keys} target='_blank' size='xs'>API keys</Anchor> in your {preset.provider}{' '}
                    account. Kept where only an administrator reads it, and sent to {preset.provider} alone.
                  </>
                )
                : 'The bearer key the service expects, if it wants one. Sent to this address alone.'}
              placeholder={sameService && keySet ? 'Set — type a new one to replace it' : preset ? 'Paste the key' : 'None'}
              autoComplete='new-password'
              value={draft.key}
              disabled={save.busy}
              onChange={(event) => change({ key: event.currentTarget.value })}
            />
            <Autocomplete
              label='Model'
              description={sameService && offered.data?.length
                ? `The models ${draft.provider || 'the service'} offers.`
                : 'The model’s name as the service writes it; once the key is saved, its list is offered here.'}
              data={models}
              value={draft.model}
              disabled={save.busy}
              onChange={(value) => change({ model: value })}
            />
            <Alert variant='light' color='blue' icon={<TablerIcon name='world' size={16} />} p='xs'>
              Questions, and the names, places and texts the assistant reads in the archive to answer them, are sent to{' '}
              {draft.provider || 'this service'}. Pictures and recordings are not. Tell the people who use this EiN before you switch.
            </Alert>
          </Stack>
        </Paper>
      )}

      <SaveBar save={save} dirty={dirty} blocked={blocked} onCancel={() => setDraft(saved)} onSave={onSave} />

      <Paper p='md' radius='md' withBorder>
        <Stack gap='xs'>
          <Text fw={600}>Now</Text>
          {checks.data
            ? checks.data.map((check) => <Check key={`${check.name}-${check.reason}`} check={check} />)
            : checks.loading
            ? <Skeleton height={20} />
            : <Text size='sm' c='dimmed'>{checks.error?.message ?? 'No answer.'}</Text>}
        </Stack>
      </Paper>
    </Stack>
  );
}
