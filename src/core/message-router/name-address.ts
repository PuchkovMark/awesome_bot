const name = 'пенек';
const requests = new Set([
  'помоги',
  'подскажи',
  'расскажи',
  'объясни',
  'покажи',
  'скажи',
  'ответь',
]);
/** Консервативная грамматика; цитаты и неоднозначность не дают обычного обращения. */
export function ownNameText(text: string) {
  const normalized = text.normalize('NFC').toLocaleLowerCase('ru').replaceAll('ё', 'е');
  return normalized.replace(/«[^»]*»|“[^”]*”|"[^"\n]*"|\x60[^\x60]*\x60/gu, ' ');
}

export function directlyAddressesName(text: string): boolean {
  const visible = ownNameText(text);
  const words: string[] = visible.match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (!words.includes(name)) return false;
  const nameIndex = words.indexOf(name);
  if (
    ['молчит', 'работает', 'пишет', 'ответил', 'помог', 'сказал'].includes(
      words[nameIndex + 1] ?? '',
    ) ||
    ['о', 'про', 'бот', 'бота', 'боту', 'настроить'].includes(words[nameIndex - 1] ?? '')
  )
    return false;
  const rest = words.filter((w) => w !== name);
  if (!rest.length) return true;
  // Явная передача слов, третье лицо и другой адресат имеют приоритет.
  if (/(?:^|\s)(он|она|они|бот|бота|боту|сказал|сказала|обсуждали)(?:\s|$)/u.test(rest.join(' ')))
    return false;
  const imperative = rest.findIndex((w) => requests.has(w));
  if (imperative > 0 && !['пожалуйста', 'ты', 'мне', 'нам'].includes(rest[0]!)) return false;
  return (
    imperative >= 0 ||
    rest.some((w) => ['ты', 'тебе', 'тебя', 'твой', 'привет', 'здравствуй'].includes(w)) ||
    rest.join(' ').includes('как дела')
  );
}
