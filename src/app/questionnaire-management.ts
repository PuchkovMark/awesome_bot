import { splitVkText, vkMessageLength } from '../channels/vk/outbound-text';
import type { QuestionnaireRevision } from '../contracts/questionnaire';

export function questionnaireEditorParts(questions: QuestionnaireRevision['questions']) {
  const header =
    'Ответьте на это сообщение номером вопроса и новым ответом, например «2 Казань». Список действует 24 часа.';
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
