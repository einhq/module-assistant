import { ListFilterInput, PageBar, PageLoader, TablerIcon } from '@ein/ui/components';
import { ActionIcon, Anchor, Box, Button, Group, Menu, Paper, ScrollArea, Stack, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import { activeChatId, chatLoadingIds, chatsLoading, chatSummaries, createChat, deleteChat, ensureActiveChat, guestChat, openChat } from '../signals/chat.ts';
import { currentUser } from '@ein/ui/signals';
import { usePhone } from '@ein/ui/hooks';
import { type MouseEvent, useEffect, useRef, useState } from 'react';
import { ChatInput } from './ChatInput.tsx';
import { ChatMessages } from './ChatMessages.tsx';
import { formatChatTime } from './chat-time.ts';

const when = (date: Date): string => {
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? formatChatTime(date)
    : date.toLocaleDateString([], { month: 'short', day: 'numeric', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
};

/**
 * The recent chats, those whose title holds `filter` when there is one; `onPick` hears a chat
 * being opened, so a menu holding them can close.
 */
function RecentChats({ compact = false, filter = '', onPick }: { compact?: boolean; filter?: string; onPick?: () => void }) {
  useSignals();
  const needle = filter.trim().toLocaleLowerCase();
  const chats = needle ? chatSummaries.value.filter((chat) => chat.title.toLocaleLowerCase().includes(needle)) : chatSummaries.value;
  const active = activeChatId.value;

  const rows = chats.length === 0
    ? <Text size='sm' c='dimmed' p='sm'>{needle ? 'No chats match' : 'No previous chats'}</Text>
    : chats.map((chat) => (
      <Group key={chat.id} gap={4} wrap='nowrap' align='center'>
        <UnstyledButton
          onClick={() => {
            onPick?.();
            void openChat(chat.id);
          }}
          style={{
            flex: 1,
            minWidth: 0,
            padding: '8px 10px',
            borderRadius: 'var(--mantine-radius-sm)',
            background: chat.id === active ? 'var(--mrx-surface-raised)' : undefined,
          }}
        >
          <Text size='sm' truncate fw={chat.id === active ? 600 : 400}>{chat.title}</Text>
          <Text size='xs' c='dimmed'>{when(chat.updatedAt)} · {chat.messageCount} {chat.messageCount === 1 ? 'message' : 'messages'}</Text>
        </UnstyledButton>
        {!compact && (
          <Tooltip label='Delete chat'>
            <ActionIcon
              variant='subtle'
              color='gray'
              size='sm'
              disabled={chatLoadingIds.value.includes(chat.id)}
              onClick={() => {
                if (globalThis.confirm(`Delete “${chat.title}”?`)) void deleteChat(chat.id);
              }}
              aria-label={`Delete ${chat.title}`}
            >
              <TablerIcon name='trash' size={14} />
            </ActionIcon>
          </Tooltip>
        )}
      </Group>
    ));

  return <Stack gap={2}>{rows}</Stack>;
}

/** The bar's round buttons: finger-sized on a phone, as the app header's are. */
const BAR_BUTTON = { size: 36, icon: 22 };

/** The new-chat button, first of the bar's controls on the page, in the drawer and in the dialog alike. */
function NewChatButton() {
  const phone = usePhone();
  return (
    <Tooltip label='New chat'>
      <ActionIcon variant='subtle' size={phone ? BAR_BUTTON.size : undefined} onClick={() => void createChat()} aria-label='New chat'>
        <TablerIcon name='plus' size={phone ? BAR_BUTTON.icon : 17} />
      </ActionIcon>
    </Tooltip>
  );
}

function HistoryMenu() {
  const phone = usePhone();
  const [opened, setOpened] = useState(false);
  const [filter, setFilter] = useState('');
  return (
    <Menu shadow='md' width={400} position='bottom-end' opened={opened} onChange={setOpened}>
      <Menu.Target>
        <Tooltip label='Recent chats'>
          <ActionIcon variant='subtle' size={phone ? BAR_BUTTON.size : undefined} aria-label='Recent chats'>
            <TablerIcon name='history' size={phone ? BAR_BUTTON.icon : 17} />
          </ActionIcon>
        </Tooltip>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Recent chats</Menu.Label>
        <Box px={4} pb='xs'>
          <ListFilterInput value={filter} onChange={setFilter} what='chats' size='sm' />
        </Box>
        <ScrollArea.Autosize mah={420} type='auto' scrollbars='y' px={4} styles={{ content: { minWidth: 0 } }}>
          <RecentChats compact filter={filter} onPick={() => setOpened(false)} />
        </ScrollArea.Autosize>
      </Menu.Dropdown>
    </Menu>
  );
}

/**
 * The chat page's controls, for the right of its `PageBar`: the new-chat button, and on a phone,
 * where the recent-chats pane is not beside the chat, a menu of the chats — none for the guest,
 * who keeps none.
 */
export function ChatPageControls({ phone = false }: { phone?: boolean }) {
  useSignals();
  return (
    <>
      <NewChatButton />
      {phone && !guestChat.value && <HistoryMenu />}
    </>
  );
}

/** The chat dialog's controls, beside its title: the new-chat button, and the chats' menu but for the guest. */
export function ChatDialogControls() {
  useSignals();
  return (
    <>
      <NewChatButton />
      {!guestChat.value && <HistoryMenu />}
    </>
  );
}

/**
 * The recent chats beside the chat on the chat page, under a filter over their titles; the page's
 * bar above holds its title and the new-chat button. A box standing in the page's margin rather
 * than a pane wall to wall, bordered as a list worked in is, like Settings' lists of users and groups.
 */
export function ChatHistoryPane() {
  useSignals();
  const [filter, setFilter] = useState('');
  if (guestChat.value) return null;
  return (
    <Box w={340} h='100%' p='md' pr={0} style={{ flex: '0 0 340px', overflow: 'hidden' }} visibleFrom='sm'>
      <Paper h='100%' p='sm' radius='md' withBorder>
        <Stack gap='xs' h='100%'>
          <ListFilterInput value={filter} onChange={setFilter} what='chats' size='sm' />
          <ScrollArea type='auto' scrollbars='y' offsetScrollbars='y' style={{ flex: 1, minHeight: 0 }}>
            <RecentChats filter={filter} />
          </ScrollArea>
        </Stack>
      </Paper>
    </Box>
  );
}

/**
 * The drawer's title, a link to the chat in view as the page: `onOpenPage` opens it there, and a
 * click that asks for another tab or window is the browser's.
 */
function OpenAsPageTitle({ chatId, onOpenPage }: { chatId: string | null; onOpenPage: (to: string) => void }) {
  const to = chatId ? `/chat/${encodeURIComponent(chatId)}` : '/chat';
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onOpenPage(to);
  };
  return (
    <Tooltip label='Open as page' withArrow openDelay={300}>
      <Anchor href={to} onClick={open} inherit c='inherit' underline='hover'>Chat</Anchor>
    </Tooltip>
  );
}

/**
 * The chat workspace, in the drawer or as the chat page. On the page the URL names the chat
 * (`/chat/<id>`): `chatId` is the one to open, and `onChatChange` hears each chat that becomes
 * active afterwards — only once the named one is open, or the latest would take the link over.
 * In the drawer it is one chat, the one last open or else the latest; its title opens it as the
 * page (`onOpenPage`). `framed`, in the dialog, it is the same one chat without a bar of its own:
 * the dialog's header is its bar (`ChatDialogControls`). The guest's one conversation has no address a reload could open, so it is
 * never told to `onChatChange`.
 */
export function ChatWorkspace({ onClose, onOpenPage, page = false, framed = false, chatId, onChatChange }: {
  onClose?: () => void;
  onOpenPage?: (to: string) => void;
  page?: boolean;
  framed?: boolean;
  chatId?: string;
  onChatChange?: (id: string) => void;
}) {
  useSignals();
  const phone = usePhone();
  const username = currentUser.value?.username;
  const guest = guestChat.value;
  const [error, setError] = useState<string>();
  const [ready, setReady] = useState(false);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const active = activeChatId.value;

  useEffect(() => {
    setReady(false);
    void ensureActiveChat(chatId)
      .then(() => setReady(true))
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [username, chatId]);

  useEffect(() => {
    if (ready && active && !guest) onChatChange?.(active);
  }, [ready, active, guest]);

  const focusComposer = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('a, button, input, textarea, select, label, img, video, audio, [role="button"], [role="link"], [contenteditable="true"]')) return;
    if (globalThis.getSelection()?.isCollapsed === false) return;
    workspaceRef.current?.querySelector<HTMLTextAreaElement>('textarea[data-chat-input]')?.focus();
  };

  return (
    <Paper
      ref={workspaceRef}
      radius={0}
      className='mrx-chat-workspace'
      // On the page it is on the page's surface beside the recent chats' box; the drawer keeps its own.
      bg={page ? 'transparent' : undefined}
      style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      onClick={focusComposer}
    >
      {
        /* In the drawer the workspace carries its own slim bar, patterned as the page's is; the
           page and the dialog have their own. */
      }
      {!page && !framed && (
        <PageBar
          pattern='mixed'
          title={onOpenPage ? <OpenAsPageTitle chatId={active} onOpenPage={onOpenPage} /> : 'Chat'}
          controls={
            <>
              <NewChatButton />
              {!guest && <HistoryMenu />}
              {onClose && (
                <ActionIcon variant='subtle' size={phone ? BAR_BUTTON.size : undefined} onClick={onClose} aria-label='Close chat'>
                  <TablerIcon name='x' size={phone ? BAR_BUTTON.icon : 16} />
                </ActionIcon>
              )}
            </>
          }
        />
      )}
      {error
        ? (
          <Stack align='center' justify='center' p='xl' style={{ flex: 1 }}>
            <TablerIcon name='message-circle' size={32} color='var(--mrx-text-tertiary)' />
            <Text size='sm' c='red'>{error}</Text>
            <Button
              variant='light'
              size='xs'
              onClick={() => {
                setError(undefined);
                void ensureActiveChat().catch((cause) => setError(String(cause)));
              }}
            >
              Try again
            </Button>
          </Stack>
        )
        : activeChatId.value
        ? (
          <>
            <ChatMessages />
            <ChatInput />
          </>
        )
        : chatsLoading.value
        ? (
          <Stack justify='center' style={{ flex: 1 }}>
            <PageLoader label='Loading chats…' />
          </Stack>
        )
        : (
          <Stack align='center' justify='center' style={{ flex: 1 }}>
            <TablerIcon name='message-circle' size={32} color='var(--mrx-text-tertiary)' />
            <Text size='sm' c='dimmed'>Open a recent chat or start a new one.</Text>
            <Button variant='light' size='xs' leftSection={<TablerIcon name='message-circle-plus' size={14} />} onClick={() => void createChat()}>New chat</Button>
          </Stack>
        )}
    </Paper>
  );
}
