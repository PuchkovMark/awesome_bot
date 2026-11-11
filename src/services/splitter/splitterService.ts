export const MAX_VK_MESSAGE_LENGTH = 4000;

/**
 * Делит длинные сообщения на части, пригодные для отправки через ограничения VK.
 */
export class SplitterService {
  private maxLen: number;

  constructor(maxLen = MAX_VK_MESSAGE_LENGTH) {
    if (!Number.isInteger(maxLen) || maxLen < 1) {
      throw new Error('Message split length must be a positive integer');
    }
    this.maxLen = maxLen;
  }

  split(text: string): string[] {
    const parts: string[] = [];
    let remaining = text;
    while (remaining.length > this.maxLen) {
      const cut = this.findCut(remaining, this.maxLen);
      parts.push(remaining.slice(0, cut));
      remaining = remaining.slice(cut);
    }
    if (remaining) parts.push(remaining);
    return parts;
  }

  truncate(text: string, notice: string, suffix = ''): string {
    const textLimit = this.maxLen - suffix.length;
    if (textLimit < 0) throw new Error('Message suffix exceeds the message limit');
    if (text.length <= textLimit) return `${text}${suffix}`;
    if (notice.length >= textLimit) {
      throw new Error('Truncation notice must be shorter than the message limit');
    }
    const cut = this.findCut(text, textLimit - notice.length);
    return `${text.slice(0, cut).trimEnd()}${notice}${suffix}`;
  }

  private findCut(text: string, maxLength: number): number {
    const limit = this.safeBoundary(text, maxLength);
    if (limit === 0) throw new Error('Message limit is too small for a Unicode character');
    let cut = text.lastIndexOf('\n', limit - 1);
    if (cut < maxLength * 0.6) cut = text.lastIndexOf(' ', limit - 1);
    return cut < maxLength * 0.6 ? limit : cut + 1;
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
