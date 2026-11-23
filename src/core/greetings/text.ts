export interface GreetingTextInput {
  readonly count: number;
  readonly returning: boolean;
  readonly name?: string;
  readonly template?: string;
  readonly persona?: string;
  readonly rules?: string;
  readonly facts?: readonly { readonly fieldKey: string; readonly value: string }[];
}

export function formatGreeting(input: GreetingTextInput): string {
  const single = input.count === 1;
  const name =
    input.name
      ?.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ')
      .trim()
      .slice(0, 160) ?? '';
  const address = name ? ', ' + name : '';
  const base = !single
    ? 'Всем привет! Добро пожаловать в беседу!'
    : input.returning
      ? `С возвращением${address}!`
      : `Привет${address}! Добро пожаловать в беседу!`;
  const substitutions = {
    приветствие: base,
    имя: single ? name : '',
    персонаж: input.persona ?? '',
    правила: input.rules ?? '',
    профиль: single
      ? (input.facts?.map(({ fieldKey, value }) => fieldKey + ': ' + value).join('\n') ?? '')
      : '',
  };
  const source = input.template?.replace(/\{анкета\}/gu, '');
  const render = source
    ?.replace(
      /\{(приветствие|имя|персонаж|правила|профиль)\}/gu,
      (_, key: keyof typeof substitutions) => substitutions[key],
    )
    .trim();
  return render && render.length <= 3500 ? render : base;
}
