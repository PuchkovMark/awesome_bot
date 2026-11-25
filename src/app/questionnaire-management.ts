import { splitVkText, vkMessageLength } from '../channels/vk/outbound-text';
import type { QuestionnaireRevision } from '../contracts/questionnaire';

const header =
  'Ответьте на это сообщение номером вопроса и новым ответом, например «2 Казань». Список действует 24 часа.';
export const questionnaireDeletionPrompt =
  'Удалить вашу анкету и её ответы из профиля этой беседы? Остальные данные профиля и сообщения в VK сохранятся. В течение 15 минут ответьте на это сообщение «Удалить» или «Оставить».';

export function isQuestionnaireManagementPrompt(text: string | undefined) {
  return text === questionnaireDeletionPrompt || text?.startsWith(header + '\n\n') === true;
}

export function questionnaireEditorParts(questions: QuestionnaireRevision['questions']) {
  const parts: { text: string; first: number; last: number }[] = [];
  for (const { position, text } of questions) {
    const label = `${position}. `;
    const available = vkMessageLength.value - Buffer.byteLength(header + '\n\n' + label);
    for (const fragment of splitVkText(text, available)) {
      const line = label + fragment;
      const previous = parts.at(-1);
      if (previous && Buffer.byteLength(previous.text + '\n' + line) <= vkMessageLength.value) {
        previous.text += '\n' + line;
        previous.last = position;
      } else parts.push({ text: header + '\n\n' + line, first: position, last: position });
    }
  }
  return parts;
}
