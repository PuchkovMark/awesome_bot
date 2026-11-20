export const HISTORY_REQUEST_LIMIT = 180_000;

export function codePointLength(value: string): number {
  return Array.from(value).length;
}

/** Split without losing whitespace or Unicode code points. */
export function splitHistoryText(text: string, maxLength: number): string[] {
  if (maxLength < 1) throw new Error('History part limit must be positive');
  const points = Array.from(text);
  const parts: string[] = [];
  let position = 0;
  while (position < points.length) {
    const end = Math.min(position + maxLength, points.length);
    if (end === points.length) {
      parts.push(points.slice(position, end).join(''));
      break;
    }
    const window = points.slice(position, end).join('');
    const paragraph = window.lastIndexOf('\n\n');
    const sentences = [...window.matchAll(/[.!?…](?:["»”)]*)\s+/gu)];
    const sentence = sentences.at(-1);
    const boundary =
      paragraph >= 0 ? paragraph + 2 : sentence ? sentence.index + sentence[0].length : 0;
    const length = boundary > 0 ? codePointLength(window.slice(0, boundary)) : end - position;
    parts.push(points.slice(position, position + length).join(''));
    position += length;
  }
  return parts;
}
