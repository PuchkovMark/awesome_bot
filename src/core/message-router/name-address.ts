import { isRecapRequest } from '../chat-summaries/recap-intent';
import { unquotedText as ownNameText } from '../author-text';
import type { PassportEntry } from '../../contracts/chat-passport';

export { unquotedText as ownNameText } from '../author-text';

const name = 'пенек';
const wordsIn = (text: string): string[] => text.match(/[\p{L}\p{N}_]+/gu) ?? [];
const gateWords = (text: string) =>
  text
    .normalize('NFC')
    .toLowerCase()
    .replaceAll('ё', 'е')
    .match(/[\p{L}\p{M}\p{N}_]+/gu) ?? [];
const botName =
  /^(?:пень|пенек|пнек|пн(?:я|ю|ем|е|и|ей|ям|ями|ях)|пеньк(?:а|у|ом|е|и|ов|ам|ами|ах)|п(?:ен|н)еч(?:ек|к(?:а|у|ом|е|и|ам|ами|ах))|пеньчик(?:а|у|ом|е|и|ов|ам|ами|ах)?)$/u;

export function glossaryBotNames(entry: Pick<PassportEntry, 'text' | 'revision'>) {
  const aliases = (entry.text ?? '')
    .split(/\r?\n/u)
    .map((line) => /^\s*имена\s+бота\s*[—–-]\s*(.+?)\s*$/iu.exec(line)?.[1])
    .find((list) => list !== undefined);
  return {
    revision: entry.revision,
    names:
      aliases
        ?.split(',')
        .map((alias) => gateWords(alias).join(' '))
        .filter(Boolean) ?? [],
  };
}

export function matchGroupBotName(text: string, glossary?: ReturnType<typeof glossaryBotNames>) {
  const words = gateWords(text);
  const sequence = ' ' + words.join(' ') + ' ';
  if (glossary?.names.some((alias) => sequence.includes(' ' + alias + ' ')))
    return { glossaryRevision: glossary.revision };
  return words.some((word) => botName.test(word)) ? {} : null;
}
const requests = new Set([
  'помоги',
  'подскажи',
  'расскажи',
  'объясни',
  'покажи',
  'скажи',
  'ответь',
]);
const questionWords = new Set(['где', 'куда', 'откуда', 'когда', 'как', 'почему', 'зачем', 'что']);
const questionModifiers = new Set([
  'мы',
  'все',
  'же',
  'сегодня',
  'завтра',
  'тогда',
  'теперь',
  'сейчас',
  'обычно',
  'лучше',
  'не',
]);
const jointMotion = new Set([
  'выходим',
  'выйдем',
  'идем',
  'пойдем',
  'едем',
  'поедем',
  'приходим',
  'придем',
  'приезжаем',
  'приедем',
  'уходим',
  'уйдем',
  'уезжаем',
  'уедем',
  'стартуем',
]);
const clauseConnectives = new Set(['если', 'пока', 'хотя', 'чтобы', 'поскольку', 'а', 'и', 'или']);

function asksQuestionByName(text: string): boolean {
  // Оклик перед вопросом или сразу после него может стоять отдельной репликой.
  const address = text
    .replace(/^\s*пенек\s*[.!?]+\s*/u, 'пенек ')
    .replace(/[.!?]+\s*пенек\s*[.!?]*\s*$/u, ' пенек');
  const sentence = address
    .split(/[.!?;]+/u)
    .map((text) => ({ text, words: wordsIn(text) }))
    .find(({ words }) => words.includes(name));
  if (!sentence) return false;

  const nameIndex = sentence.words.indexOf(name);
  const question = sentence.words.filter((word) => word !== name);
  const [first, second] = question;
  const asksHour = first === 'во' && second === 'сколько';
  if (!asksHour && !questionWords.has(first ?? '')) return false;
  const start = asksHour ? 2 : 1;
  const actionIndex = question.findIndex(
    (word, index) => index >= start && !questionModifiers.has(word),
  );
  const action = question[actionIndex];
  // Спряжение указывает на «мы» или «ты» как на подлежащее главного вопроса.
  if (!action || (!jointMotion.has(action) && !/^[а-я]{2,}(?:ем|им|ешь|ишь)ся$/u.test(action)))
    return false;

  // После главного вопроса может следовать отдельное высказывание о Пеньке.
  const beforeName = question.slice(actionIndex + 1, nameIndex);
  if (beforeName.some((word) => questionWords.has(word) || clauseConnectives.has(word)))
    return false;
  return (
    nameIndex <= actionIndex ||
    question.slice(nameIndex).every((word) => questionModifiers.has(word)) ||
    /(?:^|[^\p{L}\p{N}_])пенек\s*[,—–-]/u.test(sentence.text)
  );
}

export function addressesQuestionnaireByName(text: string): boolean {
  const normalized = text.normalize('NFC');
  const address = /^\s*пен[её]к\s*,\s*/iu.exec(normalized);
  return !!address && /[\p{L}\p{N}]/u.test(ownNameText(normalized.slice(address[0].length)));
}

export function addressesRecapByName(text: string) {
  const match = /^\s*пен[её]к\s*,\s*([\s\S]+)$/iu.exec(text.normalize('NFC'));
  if (!match) return false;
  const request = match[1]!;
  return (
    /^(?:что|перескажи|сделай|дай|подведи)(?!\p{L})/iu.test(request) && isRecapRequest(request)
  );
}

export function directlyAddressesName(text: string): boolean {
  const visible = ownNameText(text);
  const words = wordsIn(visible);
  const nameIndex = words.indexOf(name);
  if (nameIndex === -1) return false;
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
  const phrase = rest.join(' ');
  if (/(?:^|\s)(он|она|они|бот|бота|боту|сказал|сказала|обсуждали)(?:\s|$)/u.test(phrase))
    return false;
  const imperative = rest.findIndex((w) => requests.has(w));
  if (imperative > 0 && !['пожалуйста', 'ты', 'мне', 'нам'].includes(rest[0]!)) return false;
  return (
    imperative >= 0 ||
    rest.some((w) => ['ты', 'тебе', 'тебя', 'твой', 'привет', 'здравствуй'].includes(w)) ||
    phrase.includes('как дела') ||
    (words.length === rest.length + 1 && asksQuestionByName(visible))
  );
}
