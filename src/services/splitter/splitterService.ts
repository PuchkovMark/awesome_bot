/**
 * SplitterService — утилита для разбиения длинных сообщений по лимиту.
 */
export class SplitterService {
  private maxLen: number;

  constructor(maxLen = 4000) {
    this.maxLen = maxLen;
  }

  split(text: string): string[] {
    const parts: string[] = [];
    for (let i = 0; i < text.length; i += this.maxLen) parts.push(text.slice(i, i + this.maxLen));
    return parts;
  }
}

const splitterService = new SplitterService();
export default splitterService;
