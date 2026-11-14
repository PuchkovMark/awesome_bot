import config from '../../config/index.js';
import { MIN_AUTO_VOICE_CHARACTERS } from '../voice/voiceLimits.js';

export type CapabilityContext = {
  isAdmin: boolean;
  imageAccess: string;
  chatMode: string;
  personalityName: string;
  personalityOptions: Array<{ id: string; name: string; description: string }>;
  isChat?: boolean;
  provider: string;
  voiceEnabledForUser: boolean;
};

export function buildBotCapabilities(context: CapabilityContext): string {
  const canUseMedia = context.isAdmin || context.imageAccess === 'all';
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
        }`
      : 'не настроен, не утверждай, что можешь искать актуальную информацию в интернете';
  const capabilities = [
    `Персонаж: «${context.personalityName}». Доступные персонажи: ${context.personalityOptions.map(({ id, name, description }) => `${name} (${id}) — ${description}`).join('; ') || 'нет'}.`,
    context.isChat
      ? 'Персонаж общий для беседы; сменить его могут администраторы или участники при наличии разрешения.'
      : 'Персонаж выбран для личного диалога.',
    `Текстовый ИИ-провайдер: ${context.provider}.`,
    ...(context.isChat
      ? [
          `Режим беседы: ${context.chatMode}; normal отвечает на обращение, active также на вопросы и просьбы, quiet — администраторам бота и при управлении личной анкетой.`,
        ]
      : []),
    'Доступны игры и текстовые приключения.',
    `Веб-поиск: ${webSearchCapability}.`,
    'Текущую дату и время можно запросить через get_current_datetime; при недоступности сервисов сообщи об этом.',
    'Город и часовой пояс можно задать командами /city и /timezone или попросить об этом через manage_location. Если они не настроены, используются Москва и Europe/Moscow по умолчанию; сообщай об этом пользователю.',
    context.isChat
      ? 'Через send_vk_message можно ответить в текущей беседе, передать сообщение её участнику или отметить его; неоднозначного адресата нужно уточнить.'
      : 'Через send_vk_message можно отправить сообщение только в текущий личный диалог.',
    `Голос: ${!config.VOICE_ENABLED ? 'модуль выключен' : !openAiReady ? 'не настроен OPENAI_API_KEY' : context.voiceEnabledForUser ? `включён для ответов ИИ длиннее ${MIN_AUTO_VOICE_CHARACTERS} символов; в беседе текст остаётся одним сообщением с голосовым вложением, в личных сообщениях каждая часть текста получает своё голосовое` : 'выключен для пользователя'}.`,
    `Медиа через OpenAI: ${openAiReady ? 'настроено' : 'не задан OPENAI_API_KEY'}; доступ ${canUseMedia ? 'разрешён' : 'только администраторам бота'}.`,
    'Новые изображения и редактирование присланных фото доступны через generate_image с теми же правами, что и /image; инструмент сам отправляет результат в диалог.',
    openAiReady
      ? 'Фото и документы из текущего сообщения или ответа можно анализировать через analyze_attachment: инструмент возвращает текст анализа, файл не сохраняется. В беседах доступ как у /analyze, в личных сообщениях — автору вложения.'
      : 'Анализ вложений недоступен: не задан OPENAI_API_KEY.',
    'Для больших пересказов и анализа истории используй run_subagent: он работает в фоне только по SQL-истории и присылает результат позже. Статус и результат последней задачи доступны через get_subagent_status.',
    'Историю можно ограничить участниками через participants: до 5 имён, полных имён или VK ID. Пенёк и имя текущего персонажа означают сообщения бота. Фильтр доступен только в групповой беседе; при неоднозначном имени уточни.',
    `Администратор бота: ${context.isAdmin ? 'да' : 'нет'}. Права администратора беседы проверяются отдельно; администраторов бота назначает только создатель.`,
  ];

  return ['Возможности и настройки:', ...capabilities.map((capability) => `- ${capability}`)].join(
    '\n',
  );
}
