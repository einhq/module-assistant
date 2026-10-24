import { CodeMirror, CoverAvatar, MediaGrid, RoutePanel, ScrollBox, TablerIcon } from '@ein/ui/components';
import { Alert, Anchor, Avatar, Box, Button, Collapse, Group, Loader, Stack, Table, Text, Timeline, Tooltip, UnstyledButton } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAssistant } from '../hooks/useAssistant.ts';
import {
  type AssistantEvent,
  type AssistantLive,
  type AssistantTable,
  type CommandEvent,
  CommandResult,
  draftView,
  eventsOf,
  groupEvents,
  proposalScript,
  readableOutput,
  routeForLink,
  routeForSearch,
  thoughtLine,
  timingLine,
  waitedLine,
  waitingLine,
  type WorkEntry,
  workLine,
} from '../lib/assistant.ts';
import { chatExamples, chatLiveTurn, chatLoading, type ChatMessage, chatMessages, chatResponsePhase, loadChatExamples } from '../signals/chat.ts';
import { currentUser, openMediaAt } from '@ein/ui/signals';
import { ChatMarkdown } from './ChatMarkdown.tsx';
import { errorCardFor, retryTextFor } from './chat-error.ts';
import { formatChatTimestamp } from './chat-time.ts';

/** Thumbnails in a drawer-width column: three or four to a row, enough to tell them apart. */
const CHAT_ROW_HEIGHT = 96;

function UserChatAvatar() {
  const user = currentUser.value;
  return user?.personPath
    ? (
      <CoverAvatar
        path={user.personPath}
        fallback={user.name?.charAt(0) || <TablerIcon name='user' size={16} />}
        fallbackSrc={user.avatarUrl}
        size={32}
        radius='xl'
        color='marine'
        alt={user.name}
        eager
      />
    )
    : (
      <Avatar src={user?.avatarUrl} size='sm' radius='xl' color='marine' alt={user?.name}>
        {user?.name?.charAt(0) || <TablerIcon name='user' size={16} />}
      </Avatar>
    );
}

function TimestampedAvatar({ timestamp, children }: { timestamp: Date; children: ReactNode }) {
  const label = formatChatTimestamp(timestamp);
  return (
    <Tooltip label={label} withArrow openDelay={300}>
      <Box component='span' tabIndex={0} aria-label={label} style={{ display: 'inline-flex', flex: '0 0 auto' }}>
        {children}
      </Box>
    </Tooltip>
  );
}

/**
 * The timeline's dots: small and plain, a colour for each kind of thing, on a thin grey line. What
 * is still going on gets a loader in place of its dot.
 */
const DOT = {
  thought: 'gray-6',
  text: 'gray-4',
  work: 'blue-5',
  answer: 'marine-4',
  error: 'red-6',
  proposal: 'yellow-5',
  card: 'teal-5',
  table: 'cyan-5',
  media: 'grape-5',
  links: 'indigo-4',
} as const;
const dot = (kind: keyof typeof DOT) => <span className='mrx-chat-dot' style={{ background: `var(--mantine-color-${DOT[kind]})` }} />;
const loader = <Loader size={10} color='gray.5' />;

/** Of a thought still streaming, the bubble shows the end: the part the model is on. */
const REASONING_TAIL = 600;

/** A thought: one faint line with how long it took, open to read. Streaming, its end shows as it comes. */
function Thought({ text, ms, streaming = false }: { text: string; ms?: number; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  if (streaming) {
    return (
      <Text size='xs' c='dimmed' fs='italic' style={{ whiteSpace: 'pre-wrap' }}>
        {text.length > REASONING_TAIL ? `…${text.slice(-REASONING_TAIL)}` : text}
      </Text>
    );
  }
  return (
    <Box>
      <UnstyledButton onClick={() => setOpen((value) => !value)} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {open ? <TablerIcon name='chevron-down' size={12} /> : <TablerIcon name='chevron-right' size={12} />}
        <Text size='xs' c='dimmed'>{thoughtLine(ms)}</Text>
      </UnstyledButton>
      <Collapse expanded={open}>
        <Text size='xs' c='dimmed' fs='italic' mt={2} style={{ whiteSpace: 'pre-wrap' }}>{text}</Text>
      </Collapse>
    </Box>
  );
}

/**
 * A command as a small card, in the proposal card's frame but only to read: the line as it ran,
 * its time, and what it printed — JSON indented, folded when long, a failure always open.
 */
function CommandCard({ command }: { command: CommandEvent }) {
  const line = command.line ?? command.summary;
  const failed = !!command.failed;
  return (
    <Box
      style={{
        border: `1px solid var(--mantine-color-${failed ? 'red-8' : 'dark-4'})`,
        borderRadius: 'var(--mantine-radius-sm)',
        overflow: 'hidden',
      }}
    >
      <Group gap={6} px='xs' py={4} wrap='nowrap' align='flex-start' style={{ borderBottom: command.output ? '1px solid var(--mantine-color-dark-4)' : undefined }}>
        {command.live && <Loader size={10} color='gray.5' mt={3} style={{ flex: '0 0 auto' }} />}
        <Box style={{ flex: 1, minWidth: 0, opacity: command.live === 'forming' ? 0.6 : undefined }}>
          <CodeMirror value={line} language='shell' readOnly chrome='block' height='auto' framed={false} />
        </Box>
        {command.ms !== undefined && !command.live && (
          <Text size='xs' c='dimmed' style={{ flex: '0 0 auto' }}>
            {(command.ms / 1000).toFixed(1)}s
          </Text>
        )}
      </Group>
      {command.output && (
        <Box px='xs' py={4}>
          <CommandOutput result={{ command: line, ok: !failed, ...(command.code !== undefined ? { exitCode: command.code } : {}), output: readableOutput(command.output) }} />
        </Box>
      )}
    </Box>
  );
}

/**
 * A run of commands, folded to one line: how many ran and their time, or that they are running, with
 * the line running now under it. Open, the commands are cards in order, with the thoughts between.
 */
function WorkGroup({ entry }: { entry: WorkEntry }) {
  const [open, setOpen] = useState(false);
  const current = entry.items.find((item): item is CommandEvent => item.kind === 'command' && !!item.live);
  return (
    <Box>
      <UnstyledButton onClick={() => setOpen((value) => !value)} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {open ? <TablerIcon name='chevron-down' size={12} /> : <TablerIcon name='chevron-right' size={12} />}
        <Text size='xs' c='dimmed'>{workLine(entry)}</Text>
      </UnstyledButton>
      {!open && current && (
        <Text size='xs' c='dimmed' ff='monospace' mt={2} lineClamp={1} style={{ wordBreak: 'break-all' }}>
          {current.line ?? current.summary}
        </Text>
      )}
      {/* Mounted only while open: each card holds editors, and a long chat has many runs. */}
      {open && (
        <Stack gap={6} mt={6}>
          {entry.items.map((item, index) => item.kind === 'thinking' ? <Thought key={index} text={item.text} ms={item.ms} /> : <CommandCard key={index} command={item} />)}
        </Stack>
      )}
    </Box>
  );
}

/** A turn's events on its timeline: commands in a row folded into one dot, thoughts faint, words as words. */
const entryItems = (events: AssistantEvent[]): ReactNode[] =>
  groupEvents(events).map((entry) => {
    if (entry.kind === 'work') {
      const busy = entry.items.some((item) => item.kind === 'command' && item.live);
      return (
        <Timeline.Item key={`e${entry.key}`} bullet={busy ? loader : dot('work')}>
          <WorkGroup entry={entry} />
        </Timeline.Item>
      );
    }
    if (entry.kind === 'thinking') {
      return (
        <Timeline.Item key={`e${entry.key}`} bullet={dot('thought')}>
          <Thought text={entry.text} ms={entry.ms} />
        </Timeline.Item>
      );
    }
    if (entry.kind === 'waited') {
      return (
        <Timeline.Item key={`e${entry.key}`} bullet={dot('thought')}>
          <Text size='xs' c='dimmed'>{waitedLine(entry.ms)}</Text>
        </Timeline.Item>
      );
    }
    return (
      <Timeline.Item key={`e${entry.key}`} bullet={dot('text')}>
        <ChatMarkdown content={entry.text} />
      </Timeline.Item>
    );
  });

/** Where a turn's timeline begins: a larger dot with the assistant's robot, so the line starts from who is speaking. */
const start = (
  <span className='mrx-chat-start'>
    <TablerIcon name='robot' size={14} />
  </span>
);

/** A turn as a timeline: the items are built by the caller, in order, after the robot that starts it. */
function TurnTimeline({ items }: { items: ReactNode[] }) {
  return (
    <Timeline className='mrx-chat-timeline' active={-1} bulletSize={12} lineWidth={1}>
      <Timeline.Item key='start' className='mrx-chat-timeline-start' bullet={start} />
      {items}
    </Timeline>
  );
}

/**
 * The turn in flight, as last sampled: its timeline so far, with the command running — or the call
 * the model is still writing — folded into the run it belongs to, then the thought streaming in,
 * the words, and the answer as it arrives. With nothing going on yet, a loader says it is thinking —
 * or waiting for the model, while it restarts.
 */
function LiveTurn({ phase, live }: { phase: AssistantLive['phase']; live?: AssistantLive }) {
  const view = live?.draft ? draftView(live.draft) : undefined;
  const answering = live?.draft?.tool === 'final_answer';
  const events: AssistantEvent[] = [...(live?.timeline ?? [])];
  // Words beside a call come before it.
  if (view?.text && !answering) events.push({ kind: 'text', text: view.text });
  if (live?.running) events.push({ kind: 'command', tool: '', args: {}, summary: live.running, line: live.running, live: 'running' });
  else if (view?.call) events.push({ kind: 'command', tool: live?.draft?.tool ?? '', args: {}, summary: view.call, line: view.call, live: 'forming' });
  const items = entryItems(events);
  // A thought still coming, before its call has begun: it folds into its run once the call is made.
  if (view?.reasoning && !view.call && !live?.running) {
    items.push(
      <Timeline.Item key='draft-thought' bullet={loader}>
        <Thought text={view.reasoning} streaming />
      </Timeline.Item>,
    );
  }
  if (answering && view?.text) {
    items.push(
      <Timeline.Item key='draft-answer' bullet={loader}>
        <ChatMarkdown content={view.text} />
      </Timeline.Item>,
    );
  }
  const busy = live?.running || view?.call || view?.reasoning || (answering && view?.text);
  if (!busy) {
    items.push(
      <Timeline.Item key='waiting' bullet={loader}>
        <Text size='sm' c='dimmed'>{waitingLine(phase)}</Text>
      </Timeline.Item>,
    );
  }
  return <TurnTimeline items={items} />;
}

/** Output longer than this folds behind its size: a bash script's inner commands echo node dumps. */
const OUTPUT_OPEN_LINES = 4;
const OUTPUT_OPEN_CHARS = 300;

/** An opened output scrolls past this height rather than pushing the conversation away. */
const OUTPUT_MAX_HEIGHT = 360;

const isJson = (text: string): boolean => {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
};

function CommandOutput({ result }: { result: CommandResult }) {
  const lines = result.output ? result.output.trimEnd().split('\n').length : 0;
  const long = lines > OUTPUT_OPEN_LINES || result.output.length > OUTPUT_OPEN_CHARS;
  const [open, setOpen] = useState(!result.ok || !long);
  const foldable = result.ok && long;
  if (!result.output) return null;
  return (
    <Box>
      {foldable && (
        <UnstyledButton onClick={() => setOpen((value) => !value)} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {open ? <TablerIcon name='chevron-down' size={12} /> : <TablerIcon name='chevron-right' size={12} />}
          <Text size='xs' c='dimmed'>
            output · {lines} {lines === 1 ? 'line' : 'lines'}
          </Text>
        </UnstyledButton>
      )}
      {open && (result.ok
        ? (
          <Box mah={OUTPUT_MAX_HEIGHT} style={{ overflow: 'auto' }}>
            <CodeMirror value={result.output.trimEnd()} language={isJson(result.output) ? 'json' : 'text'} readOnly chrome='block' height='auto' framed={false} />
          </Box>
        )
        : (
          // A failure is a message, not code: plain and red.
          <Text size='xs' ff='monospace' c='red' style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {result.output.trimEnd()}
          </Text>
        ))}
    </Box>
  );
}

/** A table scrolls past this height, its header kept in view. */
const TABLE_MAX_HEIGHT = 360;

const NUMBER = /^-?[\d\s]*\d([.,]\d+)?$/;

/**
 * The rows a command printed, as a table: its title, the rows — numbers to the right — and under
 * them the line that printed them and how many there are.
 */
function CommandTable({ table }: { table: AssistantTable }) {
  const named = table.columns.some((column) => column);
  const numeric = table.columns.map((_, index) => {
    const cells = table.rows.map((row) => row[index] ?? '').filter((cell) => cell);
    return cells.length > 0 && cells.every((cell) => NUMBER.test(cell));
  });
  const count = table.rows.length + (table.more ?? 0);
  return (
    <Box>
      {table.title && <Text size='sm' fw={600} mb={4}>{table.title}</Text>}
      <Box mah={TABLE_MAX_HEIGHT} style={{ overflow: 'auto', border: '1px solid var(--mantine-color-dark-4)', borderRadius: 'var(--mantine-radius-sm)' }}>
        <Table striped stickyHeader fz='xs' verticalSpacing={2} horizontalSpacing='xs'>
          {named && (
            <Table.Thead>
              <Table.Tr>
                {table.columns.map((column, index) => <Table.Th key={index} ta={numeric[index] ? 'right' : undefined}>{column}</Table.Th>)}
              </Table.Tr>
            </Table.Thead>
          )}
          <Table.Tbody>
            {table.rows.map((row, rowIndex) => (
              <Table.Tr key={rowIndex}>
                {table.columns.map((_, index) => (
                  <Table.Td key={index} ta={numeric[index] ? 'right' : undefined} style={{ whiteSpace: 'nowrap' }}>
                    {row[index]}
                  </Table.Td>
                ))}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Box>
      <Text size='xs' c='dimmed' mt={4} style={{ overflowWrap: 'anywhere' }}>
        <Text span ff='monospace' size='xs'>{table.line}</Text> · {count} {count === 1 ? 'row' : 'rows'}
        {table.more ? `, the first ${table.rows.length} shown` : ''}
      </Text>
    </Box>
  );
}

/** Border and status colour per state: waiting is yellow, ran green, failed or dismissed red. */
const CARD_COLOR = { pending: 'yellow', ran: 'green', failed: 'red', dismissed: 'red' } as const;
const SETTLED_WORDS = { ran: 'Done', failed: 'Failed', dismissed: 'Dismissed' } as const;

/**
 * A proposed change: a title, the exact commands each under its explanation as a shell
 * comment — editable until the decision — and the decision. The commands are shown verbatim on purpose — the card is the
 * user's chance to see what the assistant understood before anything is written. Once
 * settled, the same card stays with the outcome and what each command said, so the
 * conversation reads as what happened.
 */
function ProposalCard({ message }: { message: ChatMessage }) {
  useSignals();
  const { runProposal, dismissProposal } = useAssistant();
  const proposal = message.proposal;
  if (!proposal) return null;
  const settled = message.settled;
  const busy = chatLoading.value;
  const state = settled?.status ?? 'pending';
  const color = CARD_COLOR[state];
  const results = settled?.results ?? [];
  // The block is the user's to change until they decide; what ran is what the log then shows.
  const original = proposalScript(proposal);
  const [script, setScript] = useState(original);
  const edited = !settled && script.trim() !== original.trim();
  const shown = settled ? settled.script ?? original : script;
  return (
    <Box
      mt='xs'
      style={{
        border: `1px solid var(--mantine-color-${color}-${state === 'pending' ? 6 : 8})`,
        borderRadius: 'var(--mantine-radius-sm)',
        overflow: 'hidden',
        opacity: state === 'dismissed' ? 0.7 : 1,
      }}
    >
      <Group gap={6} px='sm' py={6} style={{ borderBottom: '1px solid var(--mantine-color-dark-4)' }}>
        <Text size='xs' fw={700}>Bash</Text>
        <Text size='xs' c='dimmed' style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{proposal.title}</Text>
      </Group>
      <CodeMirror value={shown} onChange={settled ? undefined : setScript} language='shell' readOnly={!!settled} chrome='block' height='auto' />
      {(edited || settled?.script) && (
        <Group gap={6} px='sm' pb={4}>
          <Text size='xs' c='yellow'>edited</Text>
          {edited && (
            <Anchor size='xs' onClick={() => setScript(original)}>
              reset
            </Anchor>
          )}
        </Group>
      )}
      {results.length > 0 && (
        <Stack gap={4} px='sm' pb={6}>
          {results.map((result, index) => <CommandOutput key={index} result={result} />)}
        </Stack>
      )}
      {settled
        ? (
          <Group gap={6} px='sm' py={6}>
            {settled.status === 'ran'
              ? <TablerIcon name='check' size={14} color={`var(--mantine-color-${color}-5)`} />
              : <TablerIcon name='x' size={14} color={`var(--mantine-color-${color}-5)`} />}
            <Text size='xs' c={color} fw={600}>
              {SETTLED_WORDS[settled.status]}
            </Text>
            {results[0] && (
              <Text size='xs' c='dimmed' ff='monospace'>
                · exit {results[0].exitCode ?? (results[0].ok ? 0 : '?')}
              </Text>
            )}
            {settled.status === 'failed' && settled.error && !results.length && <Text size='xs' c='red'>{settled.error}</Text>}
          </Group>
        )
        : (
          <Group gap='xs' px='sm' py={6}>
            <Button size='compact-sm' color='green' leftSection={<TablerIcon name='player-play' size={14} />} loading={busy} onClick={() => void runProposal(message, script)}>
              Run
            </Button>
            <Button size='compact-sm' variant='subtle' color='red' disabled={busy} onClick={() => void dismissProposal(message)}>
              Decline
            </Button>
          </Group>
        )}
    </Box>
  );
}

/**
 * A reply's cards, each its own dot after the answer: the proposal, the table of a command's rows,
 * the cards a module draws (each its route, as a panel), the pictures, the links.
 */
const cardItems = (message: ChatMessage): ReactNode[] => {
  const media = message.media ?? [];
  const links = message.links ?? [];
  const items: ReactNode[] = [];
  if (message.proposal) {
    items.push(
      <Timeline.Item key='proposal' bullet={dot('proposal')}>
        <ProposalCard message={message} />
      </Timeline.Item>,
    );
  }
  if (message.table) {
    items.push(
      <Timeline.Item key='table' bullet={dot('table')}>
        <CommandTable table={message.table} />
      </Timeline.Item>,
    );
  }
  for (const card of message.cards ?? []) {
    items.push(
      <Timeline.Item key={card.route} bullet={dot('card')}>
        <RoutePanel path={card.route} />
      </Timeline.Item>,
    );
  }
  if (media.length > 0) {
    items.push(
      <Timeline.Item key='media' bullet={dot('media')}>
        <MediaGrid items={media} targetRowHeight={CHAT_ROW_HEIGHT} onOpen={(index, items) => openMediaAt(index, items)} />
      </Timeline.Item>,
    );
  }
  if (links.length > 0 || message.search) {
    items.push(
      <Timeline.Item key='links' bullet={dot('links')}>
        {links.length > 0 && (
          <Group gap='xs'>
            {links.map((link) => {
              const route = routeForLink(link);
              return route
                ? (
                  <Anchor key={link.path} component={Link} to={route} size='sm'>
                    {link.label}
                  </Anchor>
                )
                : <Text key={link.path} size='sm'>{link.label}</Text>;
            })}
          </Group>
        )}
        {message.search && (
          <Button
            component={Link}
            to={routeForSearch(message.search)}
            variant='light'
            size='compact-sm'
            mt={links.length > 0 ? 8 : 0}
            leftSection={<TablerIcon name='search' size={14} />}
          >
            Show in search
          </Button>
        )}
      </Timeline.Item>,
    );
  }
  return items;
};

/** The widest the conversation and its composer get: on a wide page a question on the right should not drift far from its answer on the left. */
export const CHAT_COLUMN_WIDTH = 900;

/** Whether a reply is drawn as a timeline: it did something before answering, or has cards to show. */
const hasTimeline = (message: ChatMessage): boolean =>
  eventsOf(message).length > 0 || !!(message.proposal || message.table || message.cards?.length || message.media?.length || message.links?.length || message.search);

/**
 * An assistant reply. A turn that did anything is a timeline, as the live turn was: what it thought,
 * said and ran, then the answer, then its cards. A plain answer stays a plain answer. Where the
 * time went closes it.
 */
function AssistantTurn({ message, retryText, loading, onRetry }: {
  message: ChatMessage;
  retryText?: string;
  loading: boolean;
  onRetry: (text: string) => void;
}) {
  const answer = message.error
    ? <AssistantErrorCard message={message} retryText={retryText} loading={loading} onRetry={onRetry} />
    : <ChatMarkdown content={message.content} types={message.nodeTypes} />;
  // When it was said rides on where the time went: the reply has no avatar to carry it.
  const timing = message.elapsedMs !== undefined && (
    <Tooltip label={formatChatTimestamp(message.timestamp)} withArrow openDelay={300} position='bottom-start'>
      <Text size='xs' c='dimmed' mt={6} style={{ alignSelf: 'flex-start', width: 'fit-content' }}>
        {timingLine(message.elapsedMs)}
      </Text>
    </Tooltip>
  );
  if (!hasTimeline(message)) {
    return (
      <>
        {answer}
        {timing}
      </>
    );
  }
  const items = [
    ...entryItems(eventsOf(message)),
    <Timeline.Item key='answer' bullet={dot(message.error ? 'error' : 'answer')}>
      {answer}
    </Timeline.Item>,
    ...cardItems(message),
  ];
  return (
    <>
      <TurnTimeline items={items} />
      {timing}
    </>
  );
}

function AssistantErrorCard({ message, retryText, loading, onRetry }: {
  message: ChatMessage;
  retryText?: string;
  loading: boolean;
  onRetry: (text: string) => void;
}) {
  const card = errorCardFor(message.failure);
  return (
    <Alert color='red' variant='light' icon={<TablerIcon name='alert-triangle' size={18} />} title={card.title}>
      <Stack gap='xs'>
        <Text size='sm'>{card.text}</Text>
        {message.error && (
          <Text size='xs' ff='monospace' style={{ overflowWrap: 'anywhere' }}>
            {message.error}
          </Text>
        )}
        {retryText && (
          <Button
            color='red'
            variant='light'
            size='compact-sm'
            leftSection={<TablerIcon name='refresh' size={14} />}
            disabled={loading}
            onClick={() => onRetry(retryText)}
            style={{ alignSelf: 'flex-start' }}
          >
            Retry
          </Button>
        )}
      </Stack>
    </Alert>
  );
}

export function ChatMessages() {
  useSignals();
  const { ask } = useAssistant();
  const scrollRef = useRef<HTMLDivElement>(null);
  const messages = chatMessages.value;
  const loading = chatLoading.value;
  const responsePhase = chatResponsePhase.value;
  const live = chatLiveTurn.value;

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, loading]);

  // A turn that grows as it streams follows along — unless the reader has scrolled up to read.
  useEffect(() => {
    const box = scrollRef.current;
    if (box && box.scrollHeight - box.scrollTop - box.clientHeight < 120) box.scrollTop = box.scrollHeight;
  }, [live]);

  const empty = messages.length === 0 && !loading;
  useEffect(() => {
    if (empty) void loadChatExamples();
  }, [empty]);

  if (empty) {
    // What the modules suggest asking: the first two.
    const examples = (chatExamples.value ?? []).slice(0, 2).map((question) => `"${question}"`);
    return (
      <Stack p='md' ta='center' gap={0} align='center' justify='center' style={{ flex: 1 }}>
        <TablerIcon name='robot' size={48} color='gray' style={{ opacity: 0.5 }} />
        <Text c='dimmed' size='sm' mt='md'>
          Ask about what is kept here, or about EiN itself.
        </Text>
        {examples.length > 0 && (
          <Text c='dimmed' size='xs' mt='xs'>
            For example: {examples.join(' or ')}
          </Text>
        )}
      </Stack>
    );
  }

  return (
    <ScrollBox viewportRef={scrollRef} frameStyle={{ flex: 1 }} style={{ padding: 'var(--mantine-spacing-sm)' }}>
      <Stack gap='md' maw={CHAT_COLUMN_WIDTH} mx='auto'>
        {messages.map((message, index) => {
          const isUser = message.role === 'user';
          const retryText = !isUser && message.error ? retryTextFor(messages, index) : undefined;
          // An error card on its own is its own box; inside a timeline it is one dot of the bubble.
          const bare = !isUser && !!message.error && !hasTimeline(message);
          return (
            <Group
              key={message.id}
              align='flex-start'
              gap='sm'
              wrap='nowrap'
              style={{ flexDirection: isUser ? 'row-reverse' : 'row' }}
            >
              {isUser && (
                <TimestampedAvatar timestamp={message.timestamp}>
                  <UserChatAvatar />
                </TimestampedAvatar>
              )}
              <Box
                p={bare ? 0 : 'sm'}
                style={(theme) => ({
                  backgroundColor: bare ? 'transparent' : isUser ? theme.colors.marine[8] : theme.colors.dark[6],
                  borderRadius: theme.radius.md,
                  // An answer with pictures needs the width; a question does not.
                  maxWidth: isUser ? '80%' : '100%',
                  minWidth: 0,
                  flex: isUser ? undefined : 1,
                })}
              >
                {isUser
                  ? (
                    <Group gap={6} wrap='nowrap' align='flex-start'>
                      {message.think && (
                        <Tooltip label='Asked with "think harder"' withArrow openDelay={300}>
                          <TablerIcon
                            name='bulb'
                            size={14}
                            color='var(--mantine-color-yellow-4)'
                            style={{ flex: '0 0 auto', marginTop: 3 }}
                            aria-label='Asked with think harder'
                          />
                        </Tooltip>
                      )}
                      <Text size='sm' style={{ whiteSpace: 'pre-wrap' }}>
                        {message.content}
                      </Text>
                    </Group>
                  )
                  : <AssistantTurn message={message} retryText={retryText} loading={loading} onRetry={(text) => void ask(text)} />}
              </Box>
            </Group>
          );
        })}

        {responsePhase && (
          <Group align='flex-start' gap='sm' wrap='nowrap'>
            <Box
              p='sm'
              style={(theme) => ({
                backgroundColor: theme.colors.dark[6],
                borderRadius: theme.radius.md,
                minWidth: 0,
                flex: 1,
              })}
            >
              <LiveTurn phase={responsePhase} live={live} />
            </Box>
          </Group>
        )}
      </Stack>
    </ScrollBox>
  );
}
