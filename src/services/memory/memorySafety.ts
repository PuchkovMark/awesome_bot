import { createHash } from 'node:crypto';

const secretPattern =
  /(?:парол\p{L}*|password|api[\s_-]?key|ключ\p{L}*\s+api|токен\p{L}*|access[\s_-]?token|token(?:s)?|secret(?:s)?|секрет\p{L}*|credential\p{L}*|ssh[\s_-]?key|-----BEGIN [A-Z ]*PRIVATE KEY-----|sk-[A-Z0-9]{20,}|gh[pousr]_[A-Z0-9]{20,}|AKIA[A-Z0-9]{16}|AIza[A-Z0-9_-]{30,}|vk1\.a\.[A-Z0-9._-]+)/iu;
const sensitivePattern =
  /(?:здоров\p{L}*|болезн\p{L}*|диагноз\p{L}*|лечен\p{L}*|лекарств\p{L}*|медицин\p{L}*|инвалид\p{L}*|беремен\p{L}*|сексуальн\p{L}*\s+ориентац\p{L}*|религи\p{L}*|вероисповедан\p{L}*|атеист\p{L}*|политическ\p{L}*|политическ\p{L}*\s+взгляд\p{L}*|этническ\p{L}*|национальност\p{L}*|расов\p{L}*|биометр\p{L}*|отпечаток\s+пальц\p{L}*|health|illness|diagnos\p{L}*|medicat\p{L}*|medical|pregnan\p{L}*|religio\p{L}*|political\s+views|ethnicit\p{L}*|sexual\s+orientat\p{L}*|biometric\p{L}*)/iu;
const firstPersonPattern =
  /(?:^|[^\p{L}\p{N}])(?:я|мне|меня|мой|моя|моё|мои|у\s+меня|мне\s+нравится|я\s+люблю|i|my|mine|i\s+(?:like|love|prefer|use|work|plan))(?=$|[^\p{L}\p{N}])/iu;
const collectivePattern =
  /(?:мы\s+(?:решили|договорились|планируем|обсуждаем|обсуждали|выбрали|используем)|(?:наш|наша|наше|наши)\s+\p{L}+|для\s+всех|всей\s+беседы|в\s+беседе|общий\s+проект|общее\s+решение|we\s+(?:agreed|decided|plan|chose)|our\s+(?:project|meeting|plan|decision|conversation))/iu;
const candidatePattern =
  /(?:я\s+(?:люблю|предпочитаю|работаю|использую|планирую|занимаюсь|хочу|не\s+люблю|передумал|передумала)|мне\s+(?:нравится|важно|удобно)|мой\s+(?:проект|план|выбор|стиль)|моя\s+(?:работа|цель|команда)|мы\s+(?:решили|договорились|планируем|выбрали)|наш[аеи]?\s+\p{L}+|теперь\s+(?:я\s+)?(?:предпочитаю|использую|хочу)|больше\s+не\s+(?:использую|предлагай)|не\s+предлагай|больше\s+не\s+предлагай|i\s+(?:like|love|prefer|work|use|plan)|my\s+(?:project|preference|plan)|we\s+(?:agreed|decided|plan))/iu;

const stopWords = new Set([
  'без',
  'буду',
  'быть',
  'всегда',
  'всё',
  'всех',
  'где',
  'для',
  'есть',
  'если',
  'зачем',
  'здесь',
  'какой',
  'какая',
  'какие',
  'когда',
  'который',
  'которые',
  'мне',
  'мой',
  'моя',
  'мои',
  'можно',
  'надо',
  'нам',
  'наше',
  'наши',
  'она',
  'они',
  'оно',
  'очень',
  'потом',
  'почему',
  'просто',
  'сейчас',
  'также',
  'тебе',
  'тогда',
  'только',
  'тут',
  'уже',
  'хочу',
  'чтобы',
  'это',
  'этот',
  'этого',
  'я',
]);

export function containsSensitiveMemoryData(text: string): boolean {
  return secretPattern.test(text) || sensitivePattern.test(text);
}

export function isFirstPersonStatement(text: string): boolean {
  return firstPersonPattern.test(text);
}

export function hasCollectiveMemoryCue(text: string): boolean {
  return collectivePattern.test(text);
}

export function shouldConsiderAutomaticMemory(text: string): boolean {
  return text.trim().length >= 8 && text.length <= 2_000 && candidatePattern.test(text);
}

export function normalizeMemoryContent(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase('ru-RU').replaceAll(/\s+/gu, ' ').trim();
}

export function memoryFingerprint(text: string): string {
  return createHash('sha256').update(normalizeMemoryContent(text)).digest('hex');
}

export function memoryTerms(text: string): string[] {
  return [
    ...new Set(
      (text.toLocaleLowerCase('ru-RU').match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(
        (term) => !stopWords.has(term),
      ),
    ),
  ];
}

export function keywordRelevance(query: string, content: string): number {
  const queryTerms = memoryTerms(query);
  const contentTerms = new Set(memoryTerms(content));
  if (queryTerms.length === 0 || contentTerms.size === 0) return 0;
  const overlap = queryTerms.filter((term) => contentTerms.has(term)).length;
  return overlap / queryTerms.length;
}

export function containsInstructionLikeMemory(text: string): boolean {
  return /(?:игнорируй|обойди|не\s+соблюдай|забудь\s+предыдущие|раскрой\s+(?:секрет|системн)|выполняй\s+инструкц|ignore\s+(?:all\s+)?previous\s+instructions|disregard\s+(?:all\s+)?instructions|reveal\s+(?:the\s+)?system\s+prompt|bypass\s+(?:the\s+)?safeguards)/iu.test(
    text,
  );
}
