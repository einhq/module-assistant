import { Chart } from '@ein/ui/components';
import { shq } from '@ein/ui/lib';
import { execCommand, execScript } from '@ein/ui/signals';
import { Center, Loader, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { type ChartData, chartFrom } from '@assistant/chart';

/** A log as `cat -t` prints it, or nothing when the viewer cannot read it as one. */
const readLog = (path: string): Promise<string | undefined> => execScript(`cat -t ${shq(path)}`).catch(() => undefined);

/** A log's own unit, from its attributes. */
const unitOf = (path: string): Promise<string | undefined> =>
  execCommand<{ attrs?: Record<string, unknown> }>(`stat ${shq(path)}`)
    .then((node) => typeof node.attrs?.unit === 'string' && node.attrs.unit.trim() ? node.attrs.unit.trim() : undefined)
    .catch(() => undefined);

/** The query's `points`, written as JSON by the chat. */
const pointsOf = (text: string | null): unknown => {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * A chart: of a log, every entry by its date (`source`), or of the points the query gives — what
 * the chat draws under an answer that asked for one (a card in the assistant's own drop-in), and a
 * page of its own at the same URL. The log is read as the viewer when it is drawn.
 */
export default function ChartPage() {
  const [params] = useSearchParams();
  const query = params.toString();
  const [chart, setChart] = useState<ChartData | null | undefined>(undefined);

  useEffect(() => {
    setChart(undefined);
    let live = true;
    const raw = {
      kind: params.get('kind') ?? undefined,
      title: params.get('title') ?? undefined,
      unit: params.get('unit') ?? undefined,
      field: params.get('field') ?? undefined,
      source: params.get('source') ?? undefined,
      points: pointsOf(params.get('points')),
    };
    void chartFrom(raw, readLog, unitOf).then((drawn) => live && setChart(drawn ?? null));
    return () => {
      live = false;
    };
  }, [query]);

  if (chart === undefined) {
    return (
      <Center mih={120}>
        <Loader size='sm' />
      </Center>
    );
  }
  if (chart === null) return <Text size='sm' c='dimmed'>Nothing to chart.</Text>;
  return <Chart chart={chart} />;
}
