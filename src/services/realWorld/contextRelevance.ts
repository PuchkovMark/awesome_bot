import type {
  ContextRelevance,
  HoroscopeCategory,
  HoroscopePeriod,
  HoroscopeRequest,
  WeatherPeriod,
} from './types.js';

const zodiacSigns: Array<{ name: string; forms: string[] }> = [
  {
    name: 'Овен',
    forms: ['овен', 'овна', 'овну', 'овном', 'овне', 'овны', 'овнов', 'овнам', 'овнами'],
  },
  { name: 'Телец', forms: ['телец', 'тельца', 'тельцу', 'тельцом', 'тельце', 'тельцы', 'тельцов'] },
  {
    name: 'Близнецы',
    forms: ['близнец', 'близнецы', 'близнецов', 'близнецам', 'близнецах', 'близнецами'],
  },
  { name: 'Рак', forms: ['рак', 'рака', 'раку', 'раком', 'раке', 'раки', 'раков', 'ракам'] },
  {
    name: 'Лев',
    forms: ['лев', 'льва', 'льву', 'львом', 'льве', 'львы', 'львов', 'львам', 'львами'],
  },
  { name: 'Дева', forms: ['дева', 'девы', 'деве', 'деву', 'девой', 'девам', 'девах', 'дев'] },
  { name: 'Весы', forms: ['весы', 'весов', 'весам', 'весами', 'весах'] },
  {
    name: 'Скорпион',
    forms: [
      'скорпион',
      'скорпиона',
      'скорпиону',
      'скорпионом',
      'скорпионе',
      'скорпионы',
      'скорпионов',
      'скорпионам',
    ],
  },
  {
    name: 'Стрелец',
    forms: [
      'стрелец',
      'стрельца',
      'стрельцу',
      'стрельцом',
      'стрельце',
      'стрельцы',
      'стрельцов',
      'стрельцам',
    ],
  },
  {
    name: 'Козерог',
    forms: [
      'козерог',
      'козерога',
      'козерогу',
      'козерогом',
      'козероге',
      'козероги',
      'козерогов',
      'козерогам',
    ],
  },
  {
    name: 'Водолей',
    forms: [
      'водолей',
      'водолея',
      'водолею',
      'водолеем',
      'водолее',
      'водолеи',
      'водолеев',
      'водолеям',
    ],
  },
  { name: 'Рыбы', forms: ['рыбы', 'рыб', 'рыбам', 'рыбами', 'рыбах'] },
];

const countryNames: Array<{ code: string; forms: string[] }> = [
  { code: 'RU', forms: ['россия', 'россии', 'россию', 'россией', 'российская федерация'] },
  { code: 'BY', forms: ['беларусь', 'беларуси', 'беларусь', 'белоруссия', 'белоруссии'] },
  { code: 'UA', forms: ['украина', 'украине', 'украину', 'украины'] },
  { code: 'MD', forms: ['молдова', 'молдове', 'молдову', 'молдавия', 'молдавии'] },
  { code: 'KZ', forms: ['казахстан', 'казахстане', 'казахстана'] },
  { code: 'US', forms: ['сша', 'соединенные штаты', 'соединенных штатов', 'америка'] },
  { code: 'GB', forms: ['великобритания', 'великобритании', 'британия', 'англия', 'англии'] },
  { code: 'DE', forms: ['германия', 'германии', 'германию'] },
  { code: 'FR', forms: ['франция', 'франции', 'францию'] },
  { code: 'IT', forms: ['италия', 'италии', 'италию'] },
  { code: 'ES', forms: ['испания', 'испании', 'испанию'] },
  { code: 'PL', forms: ['польша', 'польше', 'польшу'] },
  { code: 'CZ', forms: ['чехия', 'чехии', 'чехию'] },
  { code: 'CA', forms: ['канада', 'канаде', 'канаду'] },
  { code: 'AU', forms: ['австралия', 'австралии', 'австралию'] },
  { code: 'CN', forms: ['китай', 'китае', 'китая'] },
  { code: 'JP', forms: ['япония', 'японии', 'японию'] },
  { code: 'IN', forms: ['индия', 'индии', 'индию'] },
  { code: 'TR', forms: ['турция', 'турции', 'турцию'] },
  { code: 'GE', forms: ['грузия', 'грузии', 'грузию'] },
  { code: 'AM', forms: ['армения', 'армении', 'армению'] },
  { code: 'AZ', forms: ['азербайджан', 'азербайджане', 'азербайджана'] },
  { code: 'LV', forms: ['латвия', 'латвии', 'латвию'] },
  { code: 'LT', forms: ['литва', 'литве', 'литву'] },
  { code: 'EE', forms: ['эстония', 'эстонии', 'эстонию'] },
  { code: 'FI', forms: ['финляндия', 'финляндии', 'финляндию'] },
  { code: 'SE', forms: ['швеция', 'швеции', 'швецию'] },
  { code: 'NO', forms: ['норвегия', 'норвегии', 'норвегию'] },
];

function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/gu, '')
    .replace(/ё/giu, 'е')
    .toLocaleLowerCase('ru-RU');
}

export function getCountryCodeForLocationName(name: string): string | undefined {
  const normalized = normalizeText(name);
  return countryNames.find((country) =>
    country.forms.some((form) => normalizeText(form) === normalized),
  )?.code;
}

function getExplicitLocation(text: string): string | undefined {
  const placePattern = '([\\p{L}][\\p{L}\\p{M}-]*(?:\\s+[\\p{L}][\\p{L}\\p{M}-]*){0,3}?)';
  const periodSuffix =
    '(?=\\s+(?:на\\s+)?(?:сейчас|сегодня|завтра|послезавтра|выходных|этой\\s+неделе|вечером|утром)|[,.!?;:]|$)';
  const prepositionalMatch = text.match(
    /(?:^|[\s,])(?:в|около|рядом\s+с)\s+([\p{L}][\p{L}\p{M}-]*(?:\s+[\p{L}][\p{L}\p{M}-]*){0,3}?)(?=\s+(?:сейчас|сегодня|завтра|послезавтра|на\s+выходных|на\s+этой\s+неделе|вечером|утром)|[,.!?;:]|$)/iu,
  );
  const bareWeatherMatch = text.match(
    new RegExp(
      `(?:^|[\\s,])(?:погода|погоду|погоде|прогноз(?:\\s+погоды)?|температура|температуру)\\s*[:,]?\\s+${placePattern}${periodSuffix}`,
      'iu',
    ),
  );
  const bareLocation = bareWeatherMatch?.[1]?.trim();
  const firstBareLetter = bareLocation?.[0];
  const hasProperNameCapitalization =
    firstBareLetter !== undefined && firstBareLetter !== firstBareLetter.toLocaleLowerCase('ru-RU');
  const location =
    prepositionalMatch?.[1]?.trim() ?? (hasProperNameCapitalization ? bareLocation : undefined);
  if (
    !location ||
    /^(?:городе|месте|доме|парке|природе|дороге|на|в|около|рядом|сейчас|сегодня|завтра|послезавтра)$/iu.test(
      location,
    )
  ) {
    return undefined;
  }
  return location;
}

function detectHoroscope(text: string): HoroscopeRequest | undefined {
  const normalized = normalizeText(text);
  const sign = zodiacSigns.find((item) =>
    item.forms.some((form) =>
      new RegExp(`(?:^|[^\\p{L}])${form}(?:$|[^\\p{L}])`, 'u').test(normalized),
    ),
  );
  if (!sign) return undefined;
  const hasHoroscopeIntent =
    /гороскоп|зодиак|звезд[аы]?|предсказан|что\s+(?:сегодня|завтра|на\s+этой\s+неделе)?\s*(?:ждет|ожидает)|(?:ждет|ожидает)\s+.+/u.test(
      normalized,
    );
  if (!hasHoroscopeIntent) return undefined;

  const period: HoroscopePeriod = /завтра|на\s+следующей?\s+неделе|на\s+этой\s+неделе/u.test(
    normalized,
  )
    ? /недел/u.test(normalized)
      ? 'week'
      : 'tomorrow'
    : 'today';
  const category: HoroscopeCategory = /любов|отношен|роман|партнер|партнерш/u.test(normalized)
    ? 'love'
    : /работ|карьер|финанс|деньг/u.test(normalized)
      ? 'work'
      : 'general';
  return { sign: sign.name, period, category };
}

function getWeatherPeriod(text: string): WeatherPeriod {
  if (/на\s+выходных|в\s+выходные|эти\s+выходные/u.test(text)) return 'weekend';
  if (
    /на\s+(?:(?:эту|этой|следующую|следующей|ближайшую|ближайшие|всю)\s+)?недел|на\s+несколько\s+дней|ближайш(?:ие|их)\s+дни/u.test(
      text,
    )
  ) {
    return 'week';
  }
  if (/послезавтра/u.test(text)) return 'after_tomorrow';
  if (/завтра/u.test(text)) return 'tomorrow';
  if (/сегодня/u.test(text)) return 'today';
  return 'current';
}

export function detectContextRelevance(
  text: string,
  previousMessages: string[] = [],
): ContextRelevance {
  const normalized = normalizeText(text);
  const previous = normalizeText(previousMessages.slice(-4).join(' '));
  const explicitWeather =
    /погод|прогноз|температур|дожд|ливен|морос|снег|снеж|мороз|жарк|тепл|холодн|ветер|облач|град|гроза|солнеч|ясно|погуля|прогул/u.test(
      normalized,
    );
  const outdoorPlan =
    /шашлык|пикник|на\s+природ|погуля|прогул|поезд|съезд|путешеств|на\s+дачу|покататься/u.test(
      normalized,
    );
  const continuedWeather = Boolean(
    /погод|дожд|снег|температур|поезд|природ|прогул/u.test(previous) &&
    /(?:а\s+)?(?:завтра|сегодня|вечером|утром|там|тогда|в\s+выходные)/u.test(normalized),
  );
  const weatherPeriod =
    explicitWeather || outdoorPlan || continuedWeather ? getWeatherPeriod(normalized) : undefined;
  const needsCalendar =
    /праздник|празднич|нов(?:ый|ого)\s+год|рождеств|пасх|маслениц|день\s+побед|календар|сколько\s+дн(?:ей|я)\s+до/u.test(
      normalized,
    );
  const explicitDateTime =
    /(?:котор(?:ый|ое)\s+час|сколько\s+времени|(?:какая|какой|какое)\s+(?:(?:сейчас|сегодня)\s+)?(?:дата|число|день)|сегодняшн\w*\s+дат|(?:какое\s+)?(?:сейчас\s+)?время|дата\s+и\s+время)/u.test(
      normalized,
    );
  const explicitCountryCode = countryNames.find((country) =>
    country.forms.some((name) =>
      new RegExp(`(?:^|[^\\p{L}])(?:в|по|для)\\s+${name}(?:$|[^\\p{L}])`, 'u').test(normalized),
    ),
  )?.code;
  const explicitLocation =
    weatherPeriod || needsCalendar || explicitDateTime ? getExplicitLocation(text) : undefined;
  const horoscope = detectHoroscope(text);

  return {
    ...(weatherPeriod ? { weatherPeriod } : {}),
    ...(explicitLocation ? { explicitLocation } : {}),
    explicitWeather,
    explicitDateTime,
    ...(explicitCountryCode ? { explicitCountryCode } : {}),
    needsCalendar,
    ...(horoscope ? { horoscope } : {}),
  };
}
