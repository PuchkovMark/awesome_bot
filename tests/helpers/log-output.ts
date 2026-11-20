import type { DestinationStream } from 'pino';

export function captureLogs(): {
  destination: DestinationStream;
  text: () => string;
  records: () => Array<Record<string, unknown>>;
} {
  let text = '';
  return {
    destination: { write(chunk: string) { text += chunk; } },
    text: () => text,
    records: () => text.trim() ? text.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>) : [],
  };
}
