import type { DisclosureVersion } from '../../storage/chat-disclosure-store';
import { timezoneCommand } from './timezone';

export function introductionText(
  version: DisclosureVersion,
  timezone: string,
  rights: string,
  update: boolean,
): string {
  const title = update ? 'Обновлены условия работы с сообщениями.' : 'Пенёк подключён к беседе.';
  return [
    title,
    `Для ответа в ${version.provider} передаются обращение и последние сообщения этой беседы.`,
    `Подробности раскрытия (версия ${version.version}): ${version.detailsUrl}`,
    `По вопросам о данных обращайтесь к владельцу бота: ${version.ownerContact}. Владелец может вручную удалить данные беседы.`,
    ...(version.profileNotice ? [version.profileNotice] : []),
    rights,
    `Часовой пояс: ${timezone}. Изменение администратором бота или владельцем: ${timezoneCommand} <пояс>.`,
  ].join('\n');
}
