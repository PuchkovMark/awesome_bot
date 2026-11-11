export const commandAliases = {
  help: ['помощь', 'команды'],
  settings: ['настройки'],
  stats: ['статистика'],
  personality: ['персонаж'],
  system: ['инструкция'],
  image: ['изображение'],
  edit: ['преобразить'],
  analyze: ['анализ'],
  document: ['документ'],
  ocr: ['распознатьтекст'],
  voice: ['голос', 'voise'],
  say: ['озвучить'],
  games: ['игры'],
  adventure: ['приключение'],
  inventory: ['инвентарь'],
  look: ['осмотреть'],
  inspect: ['изучить'],
  talk: ['поговорить'],
  use: ['использовать'],
  status: ['статус'],
  vote: ['голосовать'],
  journal: ['журналприключения'],
  map: ['карта'],
  hint: ['подсказка'],
  fun: ['развлечения'],
  randomjoke: ['случайнаяшутка'],
  meme: ['мем'],
  joke: ['шутка'],
  roast: ['подкол'],
  prediction: ['предсказание'],
  react: ['реакция'],
  rating: ['рейтинг'],
  story: ['история'],
  battle: ['баттл'],
  funsettings: ['настройкиюмора'],
  memeday: ['мемдня'],
  translate: ['перевод'],
  summary: ['пересказ'],
  reset: ['сброс'],
  forget: ['забыть'],
  admin: ['админка'],
  effort: ['усилие'],
  mode: ['режим'],
  imageaccess: ['доступккартинкам'],
  welcome: ['приветствие'],
  questionnaire: ['опрос', 'настройкаанкеты'],
  profile: ['профиль'],
  profiles: ['анкеты'],
  maintenance: ['обслуживание'],
  broadcast: ['рассылка'],
  users: ['пользователи'],
  logs: ['журнал'],
} as const satisfies Record<string, readonly string[]>;

const aliasesToCommands = new Map<string, string>(
  Object.entries(commandAliases).flatMap(([command, aliases]) =>
    aliases.map((alias) => [alias, command] as const),
  ),
);

export function normalizeCommandName(command: string): string {
  const normalized = command.normalize('NFKC').toLocaleLowerCase('ru-RU');
  return aliasesToCommands.get(normalized) ?? normalized;
}

export function localizeCommandReferences(text: string): string {
  return text
    .split(/(https?:\/\/\S+)/giu)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part.replace(/\/([a-z][a-z\d]*)/giu, (reference, command: string) => {
            const alias = commandAliases[command.toLowerCase() as keyof typeof commandAliases]?.[0];
            return alias ? `/${alias} (/${command})` : reference;
          }),
    )
    .join('');
}
