import { Box, Paper } from '@mantine/core';
import { PageBar } from '@ein/ui/components';
import { ChatDialogControls, ChatHistoryPane, ChatPageControls, ChatWorkspace } from '../components/ChatWorkspace.tsx';
import { usePhone, useSurface } from '@ein/ui/hooks';
import { fullscreenBesideDrawer } from '@ein/ui/signals';
import { useSignals } from '@preact/signals-react/runtime';
import { useNavigate, useParams } from 'react-router-dom';

export const handle = { fullBleed: true, title: 'Chat', pattern: 'mixed', dialogSize: 'xl', bleed: true, aside: ChatDialogControls };

/**
 * The durable multi-conversation assistant workspace, at `/chat/<id>` so a conversation can be
 * linked to. Plain `/chat` opens the latest and takes its id; switching chats moves the URL along.
 * In the side drawer (the top bar's chat button) it is the workspace alone, and its title opens the
 * chat in view as this page. The top bar's button closes the drawer too, so it has its own X only
 * beside the lightbox, which covers the top bar. In the dialog (the same buttons on a phone) the
 * dialog's header names it and holds its controls (`handle`), and it stays on the chat it opens
 * with: a move to another chat's URL would leave the dialog for the page.
 */
export default function ChatPage() {
  useSignals();
  const { id } = useParams();
  const navigate = useNavigate();
  const phone = usePhone();
  const surface = useSurface();
  const follow = (active: string) => {
    if (active !== id) navigate(`/chat/${encodeURIComponent(active)}`, { replace: !id });
  };
  if (surface.kind === 'dialog') return <ChatWorkspace framed />;
  if (surface.kind === 'drawer') {
    return <ChatWorkspace chatId={id} onChatChange={follow} onClose={fullscreenBesideDrawer.value === null ? undefined : surface.close} onOpenPage={surface.openPage} />;
  }
  return (
    <Paper
      radius={0}
      // The page's own surface, as Home has, so the recent chats' raised box stands out on it.
      bg='var(--mrx-surface-base)'
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: 'calc(100dvh - var(--app-shell-header-offset, 48px))',
        // A phone's keyboard shrinks the viewport (`interactive-widget` in index.html) to well
        // under this; a floor there would overflow the page and scroll the top bar away.
        minHeight: phone ? undefined : 420,
        overflow: 'hidden',
      }}
    >
      {
        /* The slim bar names the page and holds the new-chat button. A phone has no room for the
           recent-chats pane beside the chat, so there the bar also has a menu of the chats. */
      }
      <PageBar title='Chat' pattern='mixed' controls={<ChatPageControls phone={phone} />} />
      <Box style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <ChatHistoryPane />
        <Box style={{ flex: 1, minWidth: 0 }}>
          <ChatWorkspace page chatId={id} onChatChange={follow} />
        </Box>
      </Box>
    </Paper>
  );
}
