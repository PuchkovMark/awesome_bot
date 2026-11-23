import type { Redact } from './types.js';

// Объединение интервалов закрывает в том числе пересекающиеся секреты.
export function createRedactor(values: readonly string[]): Redact {
  const secrets = [
    ...new Set(values.filter((value) => typeof value === 'string' && value.length > 0)),
  ];
  return (text) => {
    const intervals: Array<[number, number]> = [];
    for (const secret of secrets) {
      let start = text.indexOf(secret);
      while (start !== -1) {
        intervals.push([start, start + secret.length]);
        start = text.indexOf(secret, start + 1);
      }
    }
    intervals.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const interval of intervals) {
      const previous = merged.at(-1);
      if (previous && interval[0] <= previous[1]) previous[1] = Math.max(previous[1], interval[1]);
      else merged.push([...interval]);
    }
    let result = '';
    let end = 0;
    for (const [start, nextEnd] of merged) {
      result += text.slice(end, start) + '[REDACTED]';
      end = nextEnd;
    }
    return result + text.slice(end);
  };
}
