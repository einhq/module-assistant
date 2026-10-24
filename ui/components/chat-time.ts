const SWEDISH_TIME = new Intl.DateTimeFormat('sv-SE', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const ENGLISH_FULL_TIMESTAMP = new Intl.DateTimeFormat('en-SE', {
  weekday: 'long',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export const formatChatTime = (date: Date): string => SWEDISH_TIME.format(date);
export const formatChatTimestamp = (date: Date): string => ENGLISH_FULL_TIMESTAMP.format(date);
