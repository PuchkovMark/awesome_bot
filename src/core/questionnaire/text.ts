export const completedQuestionnaireActions =
  'Посмотреть — /анкета показать. Исправить ответ — /анкета изменить. Удалить анкету — /анкета удалить.';

export const privateQuestionnaireHint =
  'Чтобы заполнить анкету, отправьте /анкета в нужной беседе.';

export const privateQuestionnaireViewHint =
  'Укажите ID беседы, например /анкета показать vk:2000000001. Добавьте упоминание, чтобы посмотреть анкету другого участника.';

export const questionnairePresentationQuestion =
  'Опубликовать ваше представление в этой беседе? Ответьте «Представить» или «Не представлять» на это сообщение. Также можно отправить /анкета представить.';

export function questionnaireListText(
  pairs: readonly { readonly question: string; readonly answer: string }[],
  heading: string,
) {
  return [heading, ...pairs.map(({ question, answer }) => `${question}\n${answer}`)].join('\n\n');
}
