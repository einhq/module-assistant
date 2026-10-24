import { TablerIcon } from '@ein/ui/components';
import { ActionIcon, Box, Group, Text, Textarea, Tooltip } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import { useEffect, useRef } from 'react';
import { useAssistant } from '../hooks/useAssistant.ts';
import { usePhone, usePolledCommand } from '@ein/ui/hooks';
import { llmNotice, type LlmStatus } from '../lib/assistant.ts';
import { activeChatId, chatCreating, chatDrafts, chatLoading, chatThink, setChatDraft, setChatThink } from '../signals/chat.ts';
import { CHAT_COLUMN_WIDTH } from './ChatMessages.tsx';

/** The box and its buttons, larger on a phone for a finger: the buttons as the app header's. */
const SIZES = {
  desk: { box: 'md', button: 28, bulb: 18, send: 16, section: 76, foot: 6 },
  phone: { box: 'lg', button: 36, bulb: 22, send: 20, section: 92, foot: 7 },
} as const;

export function ChatInput() {
  useSignals();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const chatId = activeChatId.value;
  const message = chatId ? chatDrafts.value[chatId] ?? '' : '';
  // A chat still being made has no input of its own yet (see `chatCreating`).
  const loading = chatLoading.value || chatCreating.value;
  const think = chatThink.value;
  const { ask } = useAssistant();
  const phone = usePhone();
  const size = phone ? SIZES.phone : SIZES.desk;
  const { data: llm } = usePolledCommand<LlmStatus>('llm-status');
  const notice = llmNotice(llm);

  useEffect(() => {
    if (!loading) inputRef.current?.focus();
  }, [loading]);

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!chatId || !message.trim() || loading) return;
    const text = message.trim();
    setChatDraft(chatId, '');
    inputRef.current?.focus();
    void ask(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      {
        /* The think toggle and send sit inside the box, in its bottom-right
          corner, so they stay beside the last line as the text grows and the
          box takes the column's whole width. */
      }
      <Box p='sm' maw={CHAT_COLUMN_WIDTH} mx='auto'>
        {notice && (
          <Group gap={6} wrap='nowrap' px='xs' pb={6} role='status' data-llm-notice>
            <TablerIcon name={notice.icon} size={14} style={{ flexShrink: 0 }} />
            <Text size='xs' c='dimmed'>{notice.text}</Text>
          </Group>
        )}
        <Textarea
          ref={inputRef}
          data-chat-input
          // Short on a phone: autosize measures the placeholder too, and a long one
          // wraps to three lines beside the buttons, an empty box that tall.
          placeholder={phone ? 'Ask anything…' : 'Ask about what is kept here — or EiN itself…'}
          value={message}
          onChange={(e) => chatId && setChatDraft(chatId, e.target.value)}
          onKeyDown={handleKeyDown}
          readOnly={loading || !chatId}
          aria-busy={loading}
          size={size.box}
          autosize
          minRows={1}
          maxRows={8}
          rightSectionWidth={size.section}
          rightSectionPointerEvents='all'
          styles={{ section: { alignItems: 'flex-end', paddingBottom: size.foot } }}
          rightSection={
            <Group gap={4} wrap='nowrap'>
              <Tooltip label={think ? 'Thinking harder: slower, more careful' : 'Think harder (slower)'} withArrow openDelay={300}>
                <ActionIcon
                  variant={think ? 'filled' : 'subtle'}
                  color={think ? 'yellow' : 'gray'}
                  size={size.button}
                  onClick={() => setChatThink(!think)}
                  aria-pressed={think}
                  aria-label='Think harder'
                >
                  <TablerIcon name='bulb' size={size.bulb} />
                </ActionIcon>
              </Tooltip>
              <ActionIcon
                type='submit'
                variant='filled'
                color='marine'
                size={size.button}
                disabled={!message.trim() || loading}
                title='Send'
                aria-label='Send'
              >
                <TablerIcon name='send' size={size.send} />
              </ActionIcon>
            </Group>
          }
        />
      </Box>
    </form>
  );
}
