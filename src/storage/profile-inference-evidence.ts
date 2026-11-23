function normal(value: string) {
  return value.normalize('NFC').trim().toLowerCase().replaceAll('ё', 'е').replace(/\s+/gu, ' ');
}

const fields = new Map([
  ['интерес', 'interest'],
  ['увлечение', 'interest'],
  ['хобби', 'interest'],
  ['hobby', 'interest'],
  ['hobbies', 'interest'],
  ['interests', 'interest'],
  ['город', 'city'],
  ['город проживания', 'city'],
  ['место жительства', 'city'],
  ['location', 'city'],
  ['place', 'city'],
  ['имя', 'name'],
  ['профессия', 'occupation'],
  ['работа', 'occupation'],
  ['питомец', 'pet'],
]);

export function inferenceField(field: string) {
  const key = normal(field);
  return fields.get(key) ?? key;
}

export function inferenceValue(field: string, value: string) {
  const key = normal(value);
  if (
    field === 'interest' &&
    /^(?:(?:играю в|игра в|увлекаюсь|люблю) )?шахмат(?:ы|ами)$/u.test(key)
  )
    return 'шахматы';
  return key;
}

const statements = [
  ['interest', /^(?:я\s+)?(?:люблю|увлекаюсь|интересуюсь|играю в)\s+(.+)$/iu],
  ['interest', /^(.+?)\s+[-–—]\s+мо[её]\s+(?:хобби|увлечение)$/iu],
  ['city', /^(?:я\s+)?живу\s+(?:в|на)\s+(.+)$/iu],
  ['name', /^меня\s+зовут\s+(.+)$/iu],
  ['occupation', /^(?:я\s+)?работаю\s+(.+)$/iu],
  ['pet', /^у\s+меня\s+есть\s+((?:кот|кошка|собака|п[её]с|хомяк|попугай)(?:\s+.+)?)$/iu],
] as const;
const ownField =
  /^мо(?:й|я|[её]|и)\s+([\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} _-]{0,47})\s*[-–—:]\s*(.+)$/iu;
const plainValue = /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} –-]{0,79}$/u;
const uncertain =
  /(?:^|\s)(?:не|нет|или|ли|бы|если|вроде|возможно|кажется|якобы|шучу|шутка|прикол|сарказм|цитата|цитирую|сказал[аи]?|говорит|написал[аи]?|придумай|запиши|игнорируй|добавь)(?=\s|$)/iu;

const knownFields = new Set(fields.values());

export function hasCustomInferenceField(text: string) {
  const field = ownField.exec(text.normalize('NFC').trim())?.[1];
  return field !== undefined && !knownFields.has(inferenceField(field));
}

/** Проверяем буквальное утверждение от первого лица и связь значения с ним. */
export function verifiedInference(text: string, proposedField: string, proposedValue: string) {
  const statement = text.normalize('NFC').trim().replace(/[.!]$/u, '').trim();
  const explicit = ownField.exec(statement);
  let field = explicit ? inferenceField(explicit[1]!) : '';
  let value = explicit?.[2];
  if (!value) {
    for (const [key, pattern] of statements) {
      const match = pattern.exec(statement);
      if (!match) continue;
      field = key;
      value = match[1];
      break;
    }
  }
  if (!value || !plainValue.test(value) || uncertain.test(value)) return null;
  if (
    inferenceField(proposedField) !== field ||
    inferenceValue(field, proposedValue) !== inferenceValue(field, value)
  )
    return null;
  const canonical =
    field === 'interest' && inferenceValue(field, value) === 'шахматы' ? 'шахматы' : value;
  return { fieldKey: field, value: canonical };
}
