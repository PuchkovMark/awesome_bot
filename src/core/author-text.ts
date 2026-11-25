const pairedQuotes = /«[^»]*»|“[^”]*”|"[^"\n]*"|\x60[^\x60]*\x60/gu;
const quoteLine = /^[^\S\r\n]*>.*$/mu;
const quotePattern = `${pairedQuotes.source}|"[^"]*"|${quoteLine.source}`;

function normalize(text: string) {
  return text.normalize('NFC').toLocaleLowerCase('ru').replaceAll('ё', 'е');
}

export function unquotedText(text: string): string {
  return normalize(text).replace(pairedQuotes, ' ');
}

function quoteEnd(text: string, match: RegExpExecArray): number {
  const end = match.index + match[0].length;
  const opening = match[0][0];
  if ((opening !== '«' && opening !== '“') || !match[0].includes(opening, 1)) return end;
  const closing = opening === '«' ? '»' : '”';
  let depth = 1;
  for (let position = match.index + 1; position < text.length; position++) {
    if (text[position] === opening) depth++;
    if (text[position] === closing && --depth === 0) return position + 1;
  }
  return end;
}

/** Участки текста разделены цитатами, поэтому намерение проверяется внутри каждого. */
export function unquotedParts(text: string): readonly string[] {
  const normalized = normalize(text);
  const quotes = new RegExp(quotePattern, 'gmu');
  const parts: string[] = [];
  let start = 0;
  for (let match = quotes.exec(normalized); match; match = quotes.exec(normalized)) {
    parts.push(normalized.slice(start, match.index));
    start = quoteEnd(normalized, match);
    quotes.lastIndex = start;
  }
  parts.push(normalized.slice(start));
  return parts;
}
