import { createHash } from 'node:crypto';
import config from '../../config/index.js';
import type { AIMessage, AIProvider, AIResponse } from '../ai/AIProvider.js';
import { AsyncTtlCache } from './asyncTtlCache.js';
import type {
  ContextFact,
  DateTimeContext,
  HoroscopeContextData,
  HoroscopeRequest,
} from './types.js';

export interface GeneratedHoroscope {
  response: AIResponse;
  generatedAt: string;
  expiresAt: string;
}

/**
 * Генерирует развлекательные гороскопы выбранной языковой моделью и кэширует их по запросу.
 */
export class HoroscopeProvider {
  private readonly cache = new AsyncTtlCache<GeneratedHoroscope>(500);

  async generate(
    request: HoroscopeRequest,
    provider: AIProvider,
    personalityName: string,
    personalityPrompt: string,
    dateTime: DateTimeContext,
    onGenerated?: (response: AIResponse) => Promise<void>,
  ): Promise<GeneratedHoroscope> {
    const key = [
      dateTime.localDate,
      dateTime.timeZone,
      provider.name,
      personalityName,
      createHash('sha256').update(personalityPrompt).digest('hex'),
      request.sign,
      request.period,
      request.category,
    ].join(':');

    const generated = await this.cache.get(
      key,
      config.REAL_WORLD_HOROSCOPE_CACHE_SECONDS * 1000,
      async () => {
        const response = await provider.send(
          this.createMessages(request, personalityName, personalityPrompt, dateTime),
          {
            maxTokens: 700,
            temperature: 0.85,
          },
        );
        await onGenerated?.(response);
        const generatedAt = new Date().toISOString();
        return {
          response,
          generatedAt,
          expiresAt: new Date(
            Date.parse(generatedAt) + config.REAL_WORLD_HOROSCOPE_CACHE_SECONDS * 1000,
          ).toISOString(),
        };
      },
    );
    return generated;
  }

  createFact(
    request: HoroscopeRequest,
    generated: GeneratedHoroscope,
    dateTime: DateTimeContext,
  ): ContextFact<HoroscopeContextData> {
    return {
      category: 'horoscope',
      source: 'AI-generated entertainment',
      retrievedAt: generated.generatedAt,
      expiresAt: generated.expiresAt,
      data: {
        ...request,
        date: dateTime.localDate,
        content: generated.response.content,
      },
    };
  }

  private createMessages(
    request: HoroscopeRequest,
    personalityName: string,
    personalityPrompt: string,
    dateTime: DateTimeContext,
  ): AIMessage[] {
    const periodLabel =
      request.period === 'tomorrow'
        ? 'на завтра'
        : request.period === 'week'
          ? 'на ближайшую неделю'
          : 'на сегодня';
    const categoryLabel =
      request.category === 'love'
        ? 'с акцентом на любовь и отношения'
        : request.category === 'work'
          ? 'с акцентом на работу и финансы'
          : 'общий';
    return [
      {
        role: 'system',
        content: [
          'Ты — русскоязычный автор развлекательных гороскопов. Создай оригинальный, доброжелательный и небанальный гороскоп.',
          `Выбранный персонаж бота: ${personalityName}. Сохраняй его стиль, не меняя факты запроса.\n${personalityPrompt}`,
          `Текущая дата: ${dateTime.localDate}; местное время: ${dateTime.localTime}; часовой пояс: ${dateTime.timeZone} (${dateTime.utcOffset}).`,
          `Запрос: знак ${request.sign}; период ${periodLabel}; категория ${categoryLabel}.`,
          'Для общего гороскопа кратко охвати общий настрой, отношения, работу/финансы, энергию и настроение, дай один практичный совет; по желанию добавь счастливое число и цвет. Для категории любви или работы выдели её, сохранив краткий общий прогноз.',
          'Это выдуманный развлекательный текст, а не научно подтверждённое предсказание. Не утверждай, что данные взяты у астрологического источника, и не давай опасных медицинских, юридических или финансовых советов.',
          'Отвечай по-русски естественно и кратко. Не повторяй одинаковые формулировки в каждом разделе.',
        ].join('\n\n'),
      },
      {
        role: 'user',
        content: `Расскажи гороскоп для знака ${request.sign} ${periodLabel}.`,
      },
    ];
  }
}

const horoscopeProvider = new HoroscopeProvider();
export default horoscopeProvider;
