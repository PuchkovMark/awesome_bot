import config from '../../config/index.js';

type CapabilityContext = {
  isAdmin: boolean;
  imageAccess: string;
  chatMode: string;
  personalityName: string;
  personalityIds: string[];
  isChat?: boolean;
  provider: string;
  voiceEnabledForUser: boolean;
};

const gameNames = [
  'quiz (викторина)',
  'riddle (загадка)',
  'word (угадай слово)',
  'truth (правда или действие)',
  'who (кто скорее всего?)',
  'association (ассоциации)',
  'story (интерактивная история)',
];

export function buildBotCapabilities(context: CapabilityContext): string {
  const canUseMedia = context.isAdmin || context.imageAccess === 'all';
  const imageProviderReady =
    config.IMAGE_PROVIDER === 'openai'
      ? Boolean(config.OPENAI_API_KEY)
      : Boolean(config.CLOUDFLARE_ACCOUNT_ID && config.CLOUDFLARE_API_TOKEN);
  const openAiReady = Boolean(config.OPENAI_API_KEY);
  const searchProviders = [
    ...(config.SERPER_API_KEY ? ['serper'] : []),
    ...(config.TAVILY_API_KEY ? ['tavily'] : []),
  ];
  const searchFallbackReady = Boolean(config.SERPER_API_KEY && config.TAVILY_API_KEY);
  const webSearchCapability =
    config.WEB_SEARCH_PROVIDER !== 'none' && searchProviders.length > 0
      ? `включён: ${config.WEB_SEARCH_PROVIDER} основной${
          searchFallbackReady
            ? `, при сбое включён резервный ${
                config.WEB_SEARCH_PROVIDER === 'serper' ? 'tavily' : 'serper'
              }`
            : '; для резервирования настройте оба ключа'
        }; можешь сам искать для вопросов об актуальных данных, также доступна команда /search <запрос>`
      : 'не настроен, не утверждай, что можешь искать актуальную информацию в интернете';
  const capabilities = [
    `Сейчас выбран характер «${context.personalityName}». Его можно менять командой /personality; варианты: ${context.personalityIds.join(', ')}.`,
    `Текстовый ИИ-провайдер: ${context.provider}.`,
    `В групповых беседах активен режим ${context.chatMode}: normal отвечает на обращение, active также на вопросы и явные просьбы, quiet — только на команды администратора.`,
    context.isChat
      ? 'В групповых беседах используешь только общий контекст этой беседы и различаешь участников. Личные истории участников никогда не добавляются в групповой контекст. Обычный контекст доступен 24 часа; если включён мем недели, общие сообщения этой беседы могут храниться до 7 дней только для его создания.'
      : 'Поддерживаешь личный диалог с изолированной историей текущего пользователя; контекст хранится не более 24 часов. /reset очищает текущую беседу, /forget — всю личную историю.',
    'Доступные команды: /help, /settings, /personality, /chatpersonality, /system, /reset, /forget, /stats, /summary, /translate, /games, /adventure и /fun. Развлечения: /randomjoke, /meme, /memeday, /joke, /prediction, /react, /roast, /rating, /story и /battle; настройки и отказ от шуток/мемов про себя — /funsettings. /personality позволяет выбрать собеседника; стиль юмора следует выбранному персонажу.',
    `Игры: ${gameNames.join('; ')}. Загадки сочиняются ИИ на выбранной сложности; участники могут менять её по ходу игры командами /games harder и /games easier, посмотреть уровень — /games difficulty. Запуск: /games <id>, таблица очков: /games top, остановка: /games stop.`,
    'Текстовое приключение запускается командой /adventure start [жанр|random]; доступны совместная игра, свободные действия, сохранённый журнал и инвентарь, голосование и иллюстрации. Команда /adventure help показывает команды и настройки.',
    `Веб-поиск: ${webSearchCapability}.`,
    `Голосовые сообщения: ${!config.VOICE_ENABLED ? 'модуль выключен в конфигурации; для включения требуется VOICE_ENABLED=true и перезапуск' : !openAiReady ? 'модуль включён в конфигурации, но пока не работает: не задан OPENAI_API_KEY' : context.voiceEnabledForUser ? 'включены для этого пользователя; можно распознавать входящее голосовое и озвучивать короткие ответы' : 'сервис настроен, но для этого пользователя выключен; его можно включить командой /voice on'}.`,
    `Генерация и редактирование изображений: ${imageProviderReady ? `провайдер ${config.IMAGE_PROVIDER} настроен` : `провайдер ${config.IMAGE_PROVIDER} не полностью настроен`}; ${canUseMedia ? 'для этого пользователя разрешены' : 'для этого пользователя ограничены администраторами'}. Команды /image <описание> и /edit <инструкция> с прикреплённым фото.`,
    `Анализ фото и OCR командами /analyze и /ocr, а также анализ документов командой /document доступны ${openAiReady && canUseMedia ? 'при настроенном OpenAI API' : 'только при разрешении в беседе и настроенном OPENAI_API_KEY'}. Для документов поддерживаются PDF, DOCX, ODT, PPTX, XLSX, CSV, JSON, MD, RTF и TXT размером до 8 МБ.`,
    'Создатель бота — Mark Puchkov (VK ID 388581097); его роль выше роли администратора. Только создатель назначает или снимает администраторов.',
    `Административные команды доступны ${context.isAdmin ? 'текущему пользователю' : 'только администраторам'}: /admin, /provider, /mode, /maintenance, /imageaccess, /users, /logs, /broadcast. Не раскрывай и не меняй настройки администратора без проверки прав командой бота.`,
  ];

  return [
    'Твои реальные возможности и текущие настройки:',
    ...capabilities.map((capability) => `- ${capability}`),
    'Если спрашивают, что ты умеешь, кратко перечисли подходящие возможности и команды. Описывай только перечисленные и доступные сейчас функции. Не заявляй о не реализованных возможностях, не имитируй выполнение команд и не обещай результат внешнего сервиса до его фактического получения. Если функция недоступна, прямо назови причину и нужную настройку или разрешение.',
  ].join('\n');
}
