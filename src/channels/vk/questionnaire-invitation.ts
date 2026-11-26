import type { QuestionnaireInvitationDispatch } from '../../core/greetings/invitation';
import { questionnaireInvitationWarning } from '../../core/questionnaire/text';
import { isVkGroupChat, vkId } from './normalize';
import { vkMessageLength } from './outbound-text';

const others = '\nОстальные новички тоже могут ответить на список.';
const fallback = 'новичок';

export function formatQuestionnaireInvitation(
  invitation: Pick<
    QuestionnaireInvitationDispatch,
    'questions' | 'recipients' | 'warningDelivered'
  >,
  limit: number = vkMessageLength.value,
) {
  const { questions } = invitation;
  if (!questions.trim() || Buffer.byteLength(questions) > limit || !invitation.recipients.length)
    return null;
  if (invitation.warningDelivered)
    return { stage: 'questions' as const, text: questions, notify: false, omitted: 0 };
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
  const ending = '\n' + questionnaireInvitationWarning;
  const combined = named + ending + '\n\n' + questions;
  if (Buffer.byteLength(combined) <= limit && !/\[(?:id|club|public)\d+\||@\p{L}/iu.test(questions))
    return { stage: 'questions' as const, text: combined, notify: true, omitted: 0 };
  const warning = (text: string, omitted: number) => ({
    stage: 'warning' as const,
    text,
    notify: true,
    omitted,
  });
  if (Buffer.byteLength(named + ending) <= limit) return warning(named + ending, 0);
  const short = ordered.map(([id]) => mention(id, fallback));
  if (Buffer.byteLength(short.join(', ') + ending) <= limit)
    return warning(short.join(', ') + ending, 0);

  const remainder = questionnaireInvitationWarning + others;
  const budget = limit - Buffer.byteLength(remainder);
  if (budget < 0) return null;
  const kept: string[] = [];
  let bytes = 0;
  for (const part of short) {
    bytes += Buffer.byteLength(part) + (kept.length ? 2 : 1);
    if (bytes > budget) break;
    kept.push(part);
  }
  const text = (kept.length ? kept.join(', ') + '\n' : '') + remainder;
  return warning(text, short.length - kept.length);
}
