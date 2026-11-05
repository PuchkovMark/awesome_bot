/**
 * SplitterService — утилита для разбиения длинных сообщений по лимиту.
 */
export class SplitterService {
  private maxLen: number;

  constructor(maxLen = 4000) {
    if (!Number.isInteger(maxLen) || maxLen < 1) {
      throw new Error('Message split length must be a positive integer');
    }
    this.maxLen = maxLen;
  }

  split(text: string): string[] {
    const parts: string[] = [];
    let remaining = text;
    while (remaining.length > this.maxLen) {
      const limit = this.safeBoundary(remaining, this.maxLen);
      let cut = remaining.lastIndexOf('\n', limit - 1);
      if (cut < this.maxLen * 0.6) {
        cut = remaining.lastIndexOf(' ', limit - 1);
      }
      if (cut < this.maxLen * 0.6) cut = limit;
      else if (remaining[cut] === '\n') cut += 1;
      else cut += 1;

      parts.push(remaining.slice(0, cut));
      remaining = remaining.slice(cut);
    }
    if (remaining) parts.push(remaining);
    return parts;
  }

  private safeBoundary(text: string, limit: number): number {
    if (
      limit > 0 &&
      /[\uD800-\uDBFF]/u.test(text[limit - 1]) &&
      /[\uDC00-\uDFFF]/u.test(text[limit])
    ) {
      return limit - 1;
    }
    return limit;
  }
}

const splitterService = new SplitterService();
export default splitterService;
