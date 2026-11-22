const graphemes = new Intl.Segmenter('ru', { granularity: 'grapheme' });
const sentences = new Intl.Segmenter('ru', { granularity: 'sentence' });

export const vkMessageLength = Object.freeze({ value: 4000, unit: 'utf8Bytes' as const });

interface Segment { readonly end: number; readonly bytes: number }

export function splitVkText(input: string): readonly string[] {
  const text = input.toWellFormed();
  if (!text.trim()) return [];
  const limit = vkMessageLength.value;
  if (Buffer.byteLength(text) <= limit) return [text];

  const paragraphEnds = new Set(Array.from(text.matchAll(/\n[\t \r]*\n+/gu), match => match.index + match[0].length));
  const sentenceEnds = new Set(Array.from(sentences.segment(text), piece => piece.index + piece.segment.length));
  const segments: Segment[] = [];
  for (const { segment, index } of graphemes.segment(text)) {
    const bytes = Buffer.byteLength(segment);
    if (bytes <= limit) {
      segments.push({ end: index + segment.length, bytes });
    } else {
      // Один кластер может занимать больше байтов, чем допускается для сообщения.
      let end = index;
      for (const point of segment) {
        end += point.length;
        segments.push({ end, bytes: Buffer.byteLength(point) });
      }
    }
  }

  const parts: string[] = [];
  let offset = 0;
  let start = 0;
  while (start < segments.length) {
    let next = start;
    let bytes = 0;
    let paragraph = start;
    let sentence = start;
    while (next < segments.length) {
      const piece = segments[next]!;
      if (bytes + piece.bytes > limit) break;
      bytes += piece.bytes;
      next++;
      if (paragraphEnds.has(piece.end)) paragraph = next;
      if (sentenceEnds.has(piece.end)) sentence = next;
    }
    if (next < segments.length) {
      if (paragraph > start) next = paragraph;
      else if (sentence > start) next = sentence;
    }
    const end = segments[next - 1]!.end;
    parts.push(text.slice(offset, end));
    offset = end;
    start = next;
  }
  return parts;
}
