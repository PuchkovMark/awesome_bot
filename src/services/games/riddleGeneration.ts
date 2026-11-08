export type RiddleDifficulty = 1 | 2 | 3 | 4;

export type GeneratedRiddle = {
  text: string;
  answers: string[];
  difficulty: RiddleDifficulty;
};

const difficultyDescriptions: Record<RiddleDifficulty, string> = {
  1: 'Лёгкая: короткая, понятная и с очевидным ответом.',
  2: 'Средняя: требует подумать и заметить деталь, но решается без специальных знаний.',
  3: 'Сложная: необычный образ или многошаговая логика, но ответ однозначен.',
  4: 'Экспертная: оригинальная сложная логика с конкретным ответом, без специальных знаний.',
};

export function normalizeGameAnswer(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('ru-RU')
    .replace(/[ё]/gu, 'е')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .trim()
    .replace(/\s+/gu, ' ');
}

export function getRiddleDifficulty(value: unknown): RiddleDifficulty {
  if (value === 1 || value === 2 || value === 3 || value === 4) return value;
  if (value === 5) return 4;
  return 2;
}

export function changeRiddleDifficulty(
  current: RiddleDifficulty,
  change: -1 | 1,
): RiddleDifficulty {
  return Math.max(1, Math.min(4, current + change)) as RiddleDifficulty;
}

export function getRiddleDifficultyLabel(difficulty: RiddleDifficulty): string {
  return ['лёгкая', 'средняя', 'сложная', 'экспертная'][difficulty - 1];
}

export function buildRiddlePrompt(difficulty: RiddleDifficulty, recentRiddles: string[]): string {
  return [
    `Придумай одну новую, оригинальную загадку на русском языке. Сложность ${difficulty}/4: ${difficultyDescriptions[difficulty]}`,
    'Загадка должна быть корректной, иметь один конкретный ответ и не требовать специальных знаний.',
    'Не используй общеизвестные готовые загадки и не повторяй или не перефразируй приведённые ниже предыдущие загадки.',
    'Верни только валидный JSON без Markdown и пояснений строго такой формы: {"text":"текст загадки","answers":["основной ответ","допустимый синоним"]}. Укажи от одного до трёх кратких вариантов ответа.',
    recentRiddles.length > 0
      ? `Предыдущие загадки в этой беседе, которые нельзя повторять:\n${recentRiddles.map((riddle) => `- ${riddle.slice(0, 300)}`).join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function parseGeneratedRiddle(
  content: string,
  difficulty: RiddleDifficulty,
): GeneratedRiddle {
  let value: unknown;
  try {
    value = JSON.parse(content.trim());
  } catch {
    throw new Error('AI returned an invalid riddle JSON response');
  }
  if (typeof value !== 'object' || value === null || !('text' in value) || !('answers' in value)) {
    throw new Error('AI returned an incomplete riddle');
  }
  const { text, answers } = value as { text?: unknown; answers?: unknown };
  if (
    typeof text !== 'string' ||
    text.trim().length < 10 ||
    text.trim().length > 500 ||
    !Array.isArray(answers) ||
    answers.length < 1 ||
    answers.length > 3 ||
    !answers.every(
      (answer) => typeof answer === 'string' && answer.trim().length > 0 && answer.length <= 80,
    )
  ) {
    throw new Error('AI returned a riddle with invalid text or answers');
  }
  const uniqueAnswers = [...new Set(answers.map((answer: string) => answer.trim()))];
  if (uniqueAnswers.some((answer) => !normalizeGameAnswer(answer))) {
    throw new Error('AI returned an empty riddle answer');
  }

  return { text: text.trim(), answers: uniqueAnswers, difficulty };
}
