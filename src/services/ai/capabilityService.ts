import config from '../../config/index.js';

type CapabilityContext = {
  isAdmin: boolean;
  imageAccess: string;
  chatMode: string;
  personalityName: string;
  personalityIds: string[];
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
  'adventure (текстовое приключение)',
  'detective (детектив)',
  'story (интерактивная история)',
];

export function buildBotCapabilities(context: CapabilityContext): string {
  const canUseMedia = context.isAdmin || context.imageAccess === 'all';
  const imageProviderReady =
    config.IMAGE_PROVIDER === 'openai'
      ? Boolean(config.OPENAI_API_KEY)
      : Boolean(config.CLOUDFLARE_ACCOUNT_ID && config.CLOUDFLARE_API_TOKEN);
  const openAiReady = Boolean(config.OPENAI_API_KEY);
  const capabilities = [
    `Сейчас выбран характер «${context.personalityName}». Его можно менять командой /personality; варианты: ${context.personalityIds.join(', ')}.`,
    `Текстовый ИИ-провайдер: ${context.provider}.`,
    `В групповых беседах активен режим ${context.chatMode}: normal отвечает на обращение, active также на вопросы и явные просьбы, quiet — только на команды администратора.`,
    'Поддерживаешь диалог с контекстом: личная история изолирована для пользователя и беседы; контекст хранится не более 24 часов. /reset очищает текущую беседу, /forget — всю личную историю.',
    'Доступные команды: /help, /settings, /personality, /system, /reset, /forget, /stats, /summary, /translate и /games. /summary и «Пенек пересказ» сразу создают пересказ за последние 2 часа; кнопки под ответом переключают то же сообщение на период 2 или 6 часов.',
    `Игры: ${gameNames.join('; ')}. Запуск: /games <id>, таблица очков: /games top, остановка: /games stop.`,
    `Веб-поиск: ${config.WEB_SEARCH_PROVIDER === 'brave' && config.BRAVE_SEARCH_API_KEY ? 'включён через Brave; используй явную команду /search <запрос>' : 'не настроен, не утверждай, что можешь искать актуальную информацию в интернете'}.`,
    `Голосовые сообщения: ${!config.VOICE_ENABLED ? 'модуль выключен в конфигурации; для включения требуется VOICE_ENABLED=true и перезапуск' : !openAiReady ? 'модуль включён в конфигурации, но пока не работает: не задан OPENAI_API_KEY' : context.voiceEnabledForUser ? 'включены для этого пользователя; можно распознавать входящее голосовое и озвучивать короткие ответы' : 'сервис настроен, но для этого пользователя выключен; его можно включить командой /voice on'}.`,
    `Генерация и редактирование изображений: ${imageProviderReady ? `провайдер ${config.IMAGE_PROVIDER} настроен` : `провайдер ${config.IMAGE_PROVIDER} не полностью настроен`}; ${canUseMedia ? 'для этого пользователя разрешены' : 'для этого пользователя ограничены администраторами'}. Команды /image <описание> и /edit <инструкция> с прикреплённым фото.`,
    `Анализ фото и OCR командами /analyze и /ocr, а также анализ документов командой /document доступны ${openAiReady && canUseMedia ? 'при настроенном OpenAI API' : 'только при разрешении в беседе и настроенном OPENAI_API_KEY'}. Для документов поддерживаются PDF, DOCX, ODT, PPTX, XLSX, CSV, JSON, MD, RTF и TXT размером до 8 МБ.`,
    `Административные команды доступны ${context.isAdmin ? 'текущему пользователю' : 'только администраторам'}: /admin, /provider, /mode, /maintenance, /imageaccess, /users, /logs, /broadcast. Не раскрывай и не меняй настройки администратора без проверки прав командой бота.`,
  ];

  return [
    'Твои реальные возможности и текущие настройки:',
    ...capabilities.map((capability) => `- ${capability}`),
    'Если спрашивают, что ты умеешь, кратко перечисли подходящие возможности и команды. Описывай только перечисленные и доступные сейчас функции. Не заявляй о не реализованных возможностях, не имитируй выполнение команд и не обещай результат внешнего сервиса до его фактического получения. Если функция недоступна, прямо назови причину и нужную настройку или разрешение.',
  ].join('\n');
}
