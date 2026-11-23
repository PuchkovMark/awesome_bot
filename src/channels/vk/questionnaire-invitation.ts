import type { QuestionnaireInvitationDispatch } from '../../core/greetings/invitation';
import { isVkGroupChat, vkId } from './normalize';
import { vkMessageLength } from './outbound-text';

const question = 'Хотите заполнить анкету знакомства?';
const others = '\nОстальные новички тоже могут заполнить анкету.';
const fallback = 'новичок';

export function formatQuestionnaireInvitation(
  invitation: Pick<QuestionnaireInvitationDispatch, 'action' | 'recipients'>,
  limit: number = vkMessageLength.value,
) {
  const action = invitation.action.trim();
  if (!/^\/[\p{L}\p{N}][\p{L}\p{N}\p{M} .:_-]*$/u.test(action) || !invitation.recipients.length)
    return null;
  const suffix = '\nЧтобы открыть анкету, отправьте ' + action;
  const mentions = new Map<number, { name: string; confirmedAt: number }>();
  for (const { user, name, confirmedAt } of invitation.recipients) {
    const id = vkId(Number(user.slice(3)));
    if (id === undefined || id <= 0 || user !== `vk:${id}` || isVkGroupChat(id)) return null;
    const safe =
      name
        ?.replace(/[^\p{L}\p{N}\p{M} '-]+/gu, ' ')
        .replace(/ +/gu, ' ')
        .trim() ?? '';
    mentions.set(id, { name: [...safe].slice(0, 40).join('') || fallback, confirmedAt });
  }
  const mention = (id: number, label: string) => `[id${id}|${label}]`;
  const ordered = [...mentions].sort(
    ([leftId, left], [rightId, right]) => left.confirmedAt - right.confirmedAt || leftId - rightId,
  );
  const named = ordered.map(([id, { name }]) => mention(id, name)).join(', ');
  const ending = ', ' + question + suffix;
  if (Buffer.byteLength(named + ending) <= limit) return { text: named + ending, omitted: 0 };
  const short = ordered.map(([id]) => mention(id, fallback));
  if (Buffer.byteLength(short.join(', ') + ending) <= limit)
    return { text: short.join(', ') + ending, omitted: 0 };

  const remainder = question + others + suffix;
  const budget = limit - Buffer.byteLength(remainder);
  if (budget < 0) return null;
  const kept: string[] = [];
  let bytes = 0;
  for (const part of short) {
    bytes += Buffer.byteLength(part) + 2;
    if (bytes > budget) break;
    kept.push(part);
  }
  const text = (kept.length ? kept.join(', ') + ', ' : '') + remainder;
  return { text, omitted: short.length - kept.length };
}
