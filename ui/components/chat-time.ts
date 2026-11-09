import { formatDateTime, formatTime } from '@ein/ui/lib';

export const formatChatTime = (date: Date): string => formatTime(date, { hour: '2-digit', minute: '2-digit' });

export const formatChatTimestamp = (date: Date): string =>
  formatDateTime(date, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
