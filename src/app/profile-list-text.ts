import type { ProfileCommandList, ProfileCommandPartRange } from '../storage/profile-command-store';
import { splitVkText, vkMessageLength } from '../channels/vk/outbound-text';
import type { FactSourceKind, FactVisibility } from '../storage/participant-types';

const sourceLabels: Record<FactSourceKind, string> = {
  self: 'сам участник',
  admin: 'администратор',
  inferred: 'вывод бота',
};
const visibilityLabels: Record<FactVisibility, string> = {
  chat: 'видно в беседе',
  bot: 'скрыто от беседы',
  unknown: 'видимость не определена',
};
const fieldLabels = new Map([
  ['interest', 'Интерес'],
  ['city', 'Город'],
]);

export function profileListText(list: ProfileCommandList) {
  const safeTitle = (list.title ?? list.target.chatId).replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim();
  const title = [...safeTitle].slice(0, 160).join('') || list.target.chatId;
  const titleLine = `Профиль в «${title}» (${list.target.chatId})`;
  const parts: (ProfileCommandPartRange & { readonly text: string })[] = [];
  if (!list.facts.length)
    return [{ first: 1, last: 1, text: titleLine + '\nВ профиле пока нет доступных фактов.' }];
  let text =
    titleLine +
    '\nОтветьте на сообщение списка с командой /исправить N значение, /скрыть N или /отклонить N.';
  let first = 1;
  let last = 0;
  const flush = () => {
    if (last < first) return;
    parts.push({ text, first, last });
    text = titleLine;
    first = last + 1;
  };
  for (const [index, fact] of list.facts.entries()) {
    const position = index + 1;
    const field = fieldLabels.get(fact.fieldKey) ?? fact.fieldKey;
    const line = `\n${position}. ${escapeProfileText(field)} · ${sourceLabels[fact.sourceKind]} · ${visibilityLabels[fact.visibility]}\n   ${escapeProfileText(fact.value)}`;
    if (Buffer.byteLength(text + line, 'utf8') <= vkMessageLength.value) {
      text += line;
      last = position;
      continue;
    }
    flush();
    if (Buffer.byteLength(text + line, 'utf8') <= vkMessageLength.value) {
      text += line;
      last = position;
      continue;
    }
    const firstPrefix = text + '\n';
    const prefix = titleLine + `\nПозиция ${position}, продолжение.\n`;
    const limit =
      vkMessageLength.value - Math.max(Buffer.byteLength(firstPrefix), Buffer.byteLength(prefix));
    for (const [chunk, segment] of splitVkText(line.trimStart(), limit).entries())
      parts.push({
        text: (chunk ? prefix : firstPrefix) + segment,
        first: position,
        last: position,
      });
    last = position;
    first = position + 1;
    text = titleLine;
  }
  flush();
  return parts;
}

function escapeProfileText(text: string) {
  return JSON.stringify(text).replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    (char) => '\\u{' + char.codePointAt(0)!.toString(16) + '}',
  );
}
