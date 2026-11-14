import { normalizeGameAnswer } from './riddleGeneration.js';

export type GameDifficulty = 1 | 2 | 3 | 4;
export type GameMode = 'answer' | 'truth' | 'vote' | 'association' | 'story' | 'mafia';
export type GameKind =
  | 'quiz'
  | 'riddle'
  | 'character'
  | 'word'
  | 'truth'
  | 'who'
  | 'songfilm'
  | 'association'
  | 'story'
  | 'mafia';
export type GamePlayMode = 'individual' | 'team';

export interface GameDefinition {
  id: GameKind;
  title: string;
  mode: GameMode;
  aliases: readonly string[];
  rules: string;
}

export const gameModes: Record<GameKind, GameDefinition> = {
  quiz: {
    id: 'quiz',
    title: 'Викторина',
    mode: 'answer',
    aliases: ['quiz', 'викторина'],
    rules: 'Отвечайте на вопросы; первый правильный ответ получает очки.',
  },
  riddle: {
    id: 'riddle',
    title: 'Загадки',
    mode: 'answer',
    aliases: ['riddle', 'загадка', 'загадки'],
    rules: 'Решайте логические, математические и словесные загадки.',
  },
  character: {
    id: 'character',
    title: 'Угадай персонажа',
    mode: 'answer',
    aliases: ['character', 'персонаж', 'персонажа'],
    rules: 'Угадайте известного вымышленного персонажа по описанию, эмодзи и подсказкам.',
  },
  word: {
    id: 'word',
    title: 'Угадай слово',
    mode: 'answer',
    aliases: ['word', 'слово', 'слова'],
    rules: 'Угадайте слово по описанию, буквам или перестановке букв.',
  },
  truth: {
    id: 'truth',
    title: 'Правда или действие',
    mode: 'truth',
    aliases: ['truth', 'правда', 'действие'],
    rules: 'Выбирайте «правда» или безопасное «действие»; можно пропустить задание.',
  },
  who: {
    id: 'who',
    title: 'Кто вероятнее всего?',
    mode: 'vote',
    aliases: ['who', 'вероятнее', 'кто вероятнее всего'],
    rules: 'Голосуйте за участника, который подходит под вопрос ведущего.',
  },
  songfilm: {
    id: 'songfilm',
    title: 'Угадай песню или фильм',
    mode: 'answer',
    aliases: ['songfilm', 'song', 'film', 'песня', 'фильм'],
    rules: 'Угадайте песню или фильм по оригинальной подсказке без цитирования текста.',
  },
  association: {
    id: 'association',
    title: 'Ассоциации',
    mode: 'association',
    aliases: ['association', 'ассоциация', 'ассоциации'],
    rules: 'Напишите не повторявшуюся ассоциацию к предыдущему слову в рамках темы.',
  },
  story: {
    id: 'story',
    title: 'Интерактивная история',
    mode: 'story',
    aliases: ['story', 'история'],
    rules: 'По очереди добавляйте по одному предложению к общей истории.',
  },
  mafia: {
    id: 'mafia',
    title: 'Мафия',
    mode: 'mafia',
    aliases: ['mafia', 'мафия', 'мафию'],
    rules: 'Запишитесь, получите роль в личных сообщениях и играйте дневные и ночные фазы.',
  },
};

export interface GameSettings {
  difficulty: GameDifficulty;
  rounds: number;
  maxParticipants: number;
  playMode: GamePlayMode;
  timeLimitSeconds: number;
  hintsPerRound: number;
  attemptsPerPlayer: number;
  allowSkip: boolean;
  autoAdvance: boolean;
  category: string;
}

export interface GameQuestion {
  text: string;
  answers: string[];
  hints: string[];
  category: string;
  choices?: string[];
  clueType?: 'description' | 'letters' | 'scramble' | 'emoji';
}

export interface GameStartRequest {
  kind: GameKind;
  settings: Partial<GameSettings>;
}

export type GameAction =
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'stop' }
  | { type: 'skip' }
  | { type: 'hint' }
  | { type: 'repeat' }
  | { type: 'score' }
  | { type: 'join' }
  | { type: 'next' }
  | { type: 'pass' }
  | { type: 'team' }
  | { type: 'captain' }
  | { type: 'change-difficulty'; difficulty: GameDifficulty }
  | { type: 'vote-difficulty'; direction: 'up' | 'down' };

const difficultyNames: Record<GameDifficulty, string> = {
  1: 'лёгкая',
  2: 'средняя',
  3: 'сложная',
  4: 'экспертная',
};

const defaultDifficultySettings: Record<
  GameDifficulty,
  Pick<GameSettings, 'timeLimitSeconds' | 'hintsPerRound' | 'attemptsPerPlayer'>
> = {
  1: { timeLimitSeconds: 90, hintsPerRound: 3, attemptsPerPlayer: 3 },
  2: { timeLimitSeconds: 60, hintsPerRound: 2, attemptsPerPlayer: 2 },
  3: { timeLimitSeconds: 45, hintsPerRound: 1, attemptsPerPlayer: 2 },
  4: { timeLimitSeconds: 30, hintsPerRound: 0, attemptsPerPlayer: 1 },
};

export function difficultyLabel(difficulty: GameDifficulty): string {
  return difficultyNames[difficulty];
}

export function difficultyFromValue(value: unknown): GameDifficulty {
  if (value === 1 || value === 2 || value === 3 || value === 4) return value;
  if (typeof value !== 'string') return 2;
  const normalized = value.normalize('NFKC').toLocaleLowerCase('ru-RU').replaceAll('ё', 'е');
  if (/^(?:1|easy|легк)/u.test(normalized)) return 1;
  if (/^(?:2|medium|средн)/u.test(normalized)) return 2;
  if (/^(?:3|hard|сложн)/u.test(normalized)) return 3;
  if (/^(?:4|expert|эксперт)/u.test(normalized)) return 4;
  return 2;
}

export function difficultyInText(text: string): GameDifficulty | null {
  const normalized = normalize(text);
  if (/эксперт|самый сложн/u.test(normalized)) return 4;
  if (/сложн|усложн/u.test(normalized)) return 3;
  if (/средн/u.test(normalized)) return 2;
  if (/легк|легч|проще/u.test(normalized)) return 1;
  return null;
}

export function settingsForDifficulty(
  difficulty: GameDifficulty,
  overrides: Partial<GameSettings> = {},
): GameSettings {
  return {
    difficulty,
    rounds: clampInteger(overrides.rounds, 5, 1, 20),
    maxParticipants: clampInteger(overrides.maxParticipants, 20, 1, 50),
    playMode: overrides.playMode === 'team' ? 'team' : 'individual',
    ...defaultDifficultySettings[difficulty],
    ...(overrides.timeLimitSeconds !== undefined
      ? { timeLimitSeconds: clampInteger(overrides.timeLimitSeconds, 60, 10, 300) }
      : {}),
    ...(overrides.hintsPerRound !== undefined
      ? { hintsPerRound: clampInteger(overrides.hintsPerRound, 1, 0, 5) }
      : {}),
    ...(overrides.attemptsPerPlayer !== undefined
      ? { attemptsPerPlayer: clampInteger(overrides.attemptsPerPlayer, 2, 1, 10) }
      : {}),
    allowSkip: overrides.allowSkip ?? true,
    autoAdvance: overrides.autoAdvance ?? true,
    category: normalizeCategory(overrides.category ?? 'общее'),
  };
}

export function parseGameStartOptions(text: string): Partial<GameSettings> {
  const normalized = normalize(text);
  const difficultyMatch = normalized.match(
    /(?:difficulty|сложност(?:ь|и)|уровень)\s*(?:=|:|\s)\s*(easy|medium|hard|expert|легк\w*|средн\w*|сложн\w*|эксперт\w*|[1-4])/u,
  );
  const rounds = normalized.match(/(?:rounds|раундов|вопросов)\s*(?:=|:|\s)\s*(\d{1,2})/u)?.[1];
  const maxParticipants = normalized.match(/(?:players|участников)\s*(?:=|:|\s)\s*(\d{1,2})/u)?.[1];
  const timeLimit = normalized.match(/(?:time|время)\s*(?:=|:|\s)\s*(\d{1,3})/u)?.[1];
  const hints = normalized.match(/(?:hints|подсказок)\s*(?:=|:|\s)\s*(\d)/u)?.[1];
  const attempts = normalized.match(/(?:attempts|попыток)\s*(?:=|:|\s)\s*(\d{1,2})/u)?.[1];
  const category = normalized.match(/(?:category|категория|тема)\s*(?:=|:)\s*([^,;]+)/u)?.[1];
  return {
    ...(difficultyMatch?.[1] ? { difficulty: difficultyFromValue(difficultyMatch[1]) } : {}),
    ...(rounds ? { rounds: Number(rounds) } : {}),
    ...(maxParticipants ? { maxParticipants: Number(maxParticipants) } : {}),
    ...(timeLimit ? { timeLimitSeconds: Number(timeLimit) } : {}),
    ...(hints ? { hintsPerRound: Number(hints) } : {}),
    ...(attempts ? { attemptsPerPlayer: Number(attempts) } : {}),
    ...(normalized.includes('команд') ||
    /\bteam\b/u.test(normalized) ||
    /(?:mode|режим)\s*(?:=|:)\s*team/u.test(normalized)
      ? { playMode: 'team' as const }
      : {}),
    ...(normalized.includes('индивидуал') ? { playMode: 'individual' as const } : {}),
    ...(normalized.includes('без пропуск') ||
    /(?:skip|пропуск)\s*(?:=|:)\s*(?:off|false|нет|выкл)/u.test(normalized)
      ? { allowSkip: false }
      : {}),
    ...(normalized.includes('ручной переход') ||
    /(?:auto|авто)\s*(?:=|:)\s*(?:off|false|нет|выкл)/u.test(normalized)
      ? { autoAdvance: false }
      : {}),
    ...(category ? { category: category.trim() } : {}),
  };
}

export function parseGameKind(value: string): GameKind | null {
  const normalized = normalize(value);
  for (const definition of Object.values(gameModes)) {
    if (definition.aliases.includes(normalized)) return definition.id;
  }
  return null;
}

export function detectGameStartRequest(
  text: string,
  allowNaturalStart = true,
): GameStartRequest | null {
  if (!allowNaturalStart) return null;
  const normalized = normalize(text);
  if (
    !/(?:давай|хочу|можно|сыграем|сыграть|играем|начни|начнем|начнём|начинай|запусти|устроим|организуй|поиграем|угадай|загадай)/u.test(
      normalized,
    )
  ) {
    return null;
  }

  const kind = Object.values(gameModes).find((definition) =>
    definition.aliases.some((alias) => aliasMatches(normalized, alias)),
  )?.id;
  if (!kind) return null;

  const difficulty = difficultyInText(normalized);
  const rounds = normalized.match(/(\d{1,2})\s*(?:раунд|вопрос|задани)/u)?.[1];
  const category = normalized
    .match(/(?:про|на тему)\s+([^,.!?]+)/u)?.[1]
    ?.replace(
      /\s+(?:легк\w*|средн\w*|сложн\w*|эксперт\w*|\d+\s*(?:раунд\w*|вопрос\w*|задани\w*)).*$/u,
      '',
    )
    .trim();
  const overrides: Partial<GameSettings> = {
    ...(difficulty ? { difficulty } : {}),
    ...(rounds ? { rounds: Number(rounds) } : {}),
    ...(category ? { category: category.replace(/\b(?:на|уровне)\b.+$/u, '').trim() } : {}),
    ...(normalized.includes('команд') ? { playMode: 'team' as const } : {}),
  };
  return { kind, settings: overrides };
}

export function parseGameAction(text: string): GameAction | null {
  const normalized = normalize(text)
    .replace(/[.!?]+$/u, '')
    .trim();
  const numericDifficulty = normalized.match(/(?:сложност|уров)\D*([1-4])$/u)?.[1];
  const difficulty = numericDifficulty
    ? difficultyFromValue(numericDifficulty)
    : difficultyInText(normalized);
  const difficultyIntent =
    /(?:игр|сложност|уровен|переключ|сделай|усложн|слишком просто|сложнее|легче|проще|давай теперь)/u.test(
      normalized,
    );
  if (difficulty && difficultyIntent) {
    return { type: 'change-difficulty', difficulty };
  }
  if (/^(?:пауза|поставь(?: игру)? на паузу|приостанови)(?: игру)?$/u.test(normalized))
    return { type: 'pause' };
  if (/^(?:продолжи|продолжай|возобнови)(?: игру)?$/u.test(normalized)) return { type: 'resume' };
  if (/^(?:останови|заверши|закончить|конец)(?: игру)?$/u.test(normalized)) return { type: 'stop' };
  if (/^(?:пропустить(?: вопрос| задание| раунд)?|пропуск|скип|дальше)$/u.test(normalized))
    return { type: 'skip' };
  if (/^(?:подсказка|подскажи|дай подсказку|намек)$/u.test(normalized)) return { type: 'hint' };
  if (/^(?:повтори|повтор|еще раз|ещё раз|повтори вопрос)$/u.test(normalized))
    return { type: 'repeat' };
  if (/^(?:счет|счёт|таблица|мой счет|мой счёт)$/u.test(normalized)) return { type: 'score' };
  if (
    /^(?:я в игре|присоединяюсь|присоединиться|войти в игру|добавь меня|участвую|join)$/u.test(
      normalized,
    )
  )
    return { type: 'join' };
  if (/^(?:за|согласен|голосую за)$/u.test(normalized))
    return { type: 'vote-difficulty', direction: 'up' };
  if (/^(?:против|не согласен|голосую против)$/u.test(normalized))
    return { type: 'vote-difficulty', direction: 'down' };
  if (/^(?:следующий раунд|новый раунд|начинай следующий)$/u.test(normalized))
    return { type: 'next' };
  if (/^(?:передаю ход|передать ход|пас)$/u.test(normalized)) return { type: 'pass' };
  if (/^команда(?:\s|$)/u.test(normalized)) return { type: 'team' };
  if (/^(?:капитан|назначь капитаном|выбери капитана)(?:\s|$)/u.test(normalized))
    return { type: 'captain' };
  return null;
}

export function parseGeneratedActivity(content: string): string {
  let value: unknown;
  try {
    value = JSON.parse(content.trim());
  } catch (error) {
    throw new Error('ИИ вернул некорректный JSON игрового задания.', { cause: error });
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !('text' in value) ||
    typeof value.text !== 'string' ||
    value.text.trim().length < 10 ||
    value.text.trim().length > 500
  ) {
    throw new Error('ИИ вернул задание с некорректным текстом.');
  }
  return value.text.trim();
}

export function parseGeneratedQuestion(
  content: string,
  category: string,
  history: string[],
): GameQuestion {
  let value: unknown;
  try {
    value = JSON.parse(content.trim());
  } catch (error) {
    throw new Error('ИИ вернул некорректный JSON игрового задания.', { cause: error });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ИИ вернул игровой вопрос в неверном формате.');
  }
  const result = value as Record<string, unknown>;
  const text = typeof result.text === 'string' ? result.text.trim() : '';
  const answers = Array.isArray(result.answers) ? result.answers : [];
  const hints = Array.isArray(result.hints) ? result.hints : [];
  const choices =
    result.choices === undefined ? [] : Array.isArray(result.choices) ? result.choices : null;
  if (
    text.length < 10 ||
    text.length > 700 ||
    answers.length < 1 ||
    answers.length > 4 ||
    !answers.every(
      (answer) => typeof answer === 'string' && answer.trim().length > 0 && answer.length <= 100,
    ) ||
    hints.length > 4 ||
    choices === null ||
    choices.length > 5 ||
    (choices.length > 0 && choices.length < 2) ||
    !choices.every(
      (choice) => typeof choice === 'string' && choice.trim().length > 0 && choice.length <= 120,
    ) ||
    !hints.every((hint) => typeof hint === 'string' && hint.trim().length > 0 && hint.length <= 180)
  ) {
    throw new Error('ИИ вернул задание с некорректным текстом, ответами или подсказками.');
  }
  const normalizedText = normalizeGameAnswer(text);
  if (
    history.some((previous) => normalizeGameAnswer(previous) === normalizedText) ||
    answers.some(
      (answer) =>
        typeof answer === 'string' &&
        normalizeGameAnswer(text).includes(normalizeGameAnswer(answer)) &&
        normalizeGameAnswer(answer).length >= 3,
    )
  ) {
    throw new Error('ИИ вернул повторяющееся задание или подсказку с ответом.');
  }
  const uniqueAnswers = [...new Set(answers.map((answer) => normalizeGameAnswer(String(answer))))];
  if (uniqueAnswers.some((answer) => !answer)) {
    throw new Error('ИИ вернул пустой вариант ответа.');
  }
  if (choices && choices.length > 0) {
    const normalizedChoices = choices.map((choice) =>
      normalizeGameAnswer(String(choice)).replace(/^(?:[a-e]|\d+)[.)\s:-]+/u, ''),
    );
    if (new Set(normalizedChoices).size !== normalizedChoices.length) {
      throw new Error('ИИ вернул повторяющиеся варианты ответа.');
    }
    if (normalizedChoices.filter((choice) => uniqueAnswers.includes(choice)).length !== 1) {
      throw new Error('В викторине с вариантами должен быть ровно один правильный вариант.');
    }
  }
  const clueType = ['description', 'letters', 'scramble', 'emoji'].includes(String(result.clueType))
    ? (result.clueType as GameQuestion['clueType'])
    : undefined;
  return {
    text,
    answers: uniqueAnswers,
    hints: hints.map((hint) => String(hint).trim()),
    category,
    ...(choices && choices.length > 0
      ? { choices: choices.map((choice) => String(choice).trim()) }
      : {}),
    ...(clueType ? { clueType } : {}),
  };
}

export function pointsForCorrectAnswer(
  difficulty: GameDifficulty,
  timeRemainingRatio: number,
  hintsUsed: number,
  failedAttempts: number,
): number {
  const basePoints = [1, 2, 3, 5][difficulty - 1] ?? 2;
  const speedBonus = Math.floor(basePoints * Math.max(0, Math.min(1, timeRemainingRatio)));
  const penalty = Math.min(
    basePoints + speedBonus - 1,
    Math.max(0, hintsUsed) + Math.max(0, failedAttempts),
  );
  return basePoints + speedBonus - penalty;
}

export function normalize(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase('ru-RU').replaceAll('ё', 'е').trim();
}

function normalizeCategory(category: string): string {
  const safeCategory = Array.from(category.normalize('NFKC'))
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 32 && codePoint !== 127;
    })
    .join('');
  return safeCategory.trim().slice(0, 60) || 'общее';
}

function clampInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.round(value)))
    : fallback;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function aliasMatches(text: string, alias: string): boolean {
  const boundary = '(?:^|\\s)';
  const ending = '(?:$|\\s|[,!?])';
  // alias экранируется escapeRegex перед подстановкой в шаблон.
  // eslint-disable-next-line security/detect-non-literal-regexp
  if (new RegExp(`${boundary}${escapeRegex(alias)}${ending}`, 'u').test(text)) return true;
  if (!/^[а-яё]+$/u.test(alias)) return false;
  const stem = alias.replace(/(?:ами|ями|ого|ему|ыми|ими|а|я|ы|и|у|ю|е|о)$/u, '');
  return (
    stem.length >= 3 &&
    // stem также экранируется escapeRegex перед подстановкой.
    // eslint-disable-next-line security/detect-non-literal-regexp
    new RegExp(`${boundary}${escapeRegex(stem)}[а-яё]*${ending}`, 'u').test(text)
  );
}
