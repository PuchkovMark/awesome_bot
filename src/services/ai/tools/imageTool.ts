import config from '../../../config/index.js';
import { logger } from '../../../logger/index.js';
import type { AITool } from '../AIProvider.js';
import type { GeneratedImage } from '../../image/imageGenerationService.js';
import imageGenerationService from '../../image/imageGenerationService.js';
import { getSafeImageErrorDetails } from '../../image/imageError.js';
import type { PhotoAttachment } from 'vk-io';

const MAX_PROMPT_CHARS = 4_000;

type ImageToolContext = {
  senderId: string;
  peerId: number;
  imageAccess: string;
  checkAccess: () => Promise<
    { allowed: true; isAdmin: boolean } | { allowed: false; message: string }
  >;
  getPhoto: () => Promise<PhotoAttachment | undefined>;
  sendPhoto: (image: GeneratedImage, caption: string) => Promise<void>;
  countDailyImages: () => Promise<number>;
  recordUsage: (feature: 'image_generate' | 'image_edit') => Promise<void>;
  onImageSent: () => void;
  startActivity?: () => () => void;
  service?: Pick<typeof imageGenerationService, 'generate' | 'edit'>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Создаёт новое изображение или редактирует фото из текущего сообщения/ответа.
 * Результат отправляется в текущий диалог напрямую, как команда /image или /edit.
 */
export function createImageTool(context: ImageToolContext): AITool {
  const service = context.service ?? imageGenerationService;

  return {
    name: 'generate_image',
    description: [
      'Создай новую картинку или отредактируй фотографию из текущего сообщения либо из сообщения, на которое ответил пользователь.',
      'Используй action=generate для новой картинки и action=edit для изменения приложенного или процитированного фото.',
      'В prompt передай готовое описание изображения или правки. Не передавай ссылки, ID других бесед или лишние персональные данные.',
      'Для edit нужна фотография в текущем сообщении или в ответе; если её нет, попроси пользователя прикрепить фото.',
      'Доступ проверяется как у /image: администраторы бота или беседа с imageAccess=all.',
      'Инструмент сам отправляет картинку в текущий диалог. После успешного вызова не повторяй изображение и не отправляй дублирующий итоговый текст.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['generate', 'edit'] },
        prompt: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_PROMPT_CHARS,
          description: 'Финальное описание изображения или правки.',
        },
      },
      required: ['action', 'prompt'],
      additionalProperties: false,
    },
    async execute(input) {
      if (
        !isRecord(input) ||
        Object.keys(input).some((key) => key !== 'action' && key !== 'prompt') ||
        (input.action !== 'generate' && input.action !== 'edit') ||
        typeof input.prompt !== 'string' ||
        !input.prompt.trim() ||
        input.prompt.length > MAX_PROMPT_CHARS
      ) {
        logger.warn({ senderId: context.senderId }, 'Invalid AI image tool request');
        return JSON.stringify({
          status: 'not_executed',
          message: `Укажите action (generate или edit) и описание до ${MAX_PROMPT_CHARS} символов.`,
        });
      }

      const access = await context.checkAccess();
      if (!access.allowed) {
        return JSON.stringify({ status: 'not_executed', message: access.message });
      }
      if (!access.isAdmin && context.imageAccess !== 'all') {
        return JSON.stringify({
          status: 'not_allowed',
          message: 'Генерация и редактирование изображений доступны только администраторам.',
        });
      }
      if (!context.service && !config.OPENAI_API_KEY) {
        return JSON.stringify({
          status: 'not_configured',
          message: 'OPENAI_API_KEY не настроен; изображения недоступны.',
        });
      }

      const used = await context.countDailyImages();
      if (used >= config.IMAGE_MAX_PER_USER_PER_DAY) {
        return JSON.stringify({
          status: 'limit_reached',
          message: `Дневной лимит изображений исчерпан (${config.IMAGE_MAX_PER_USER_PER_DAY}). Попробуйте завтра.`,
        });
      }

      const action = input.action;
      let photo: PhotoAttachment | undefined;
      if (action === 'edit') {
        photo = await context.getPhoto();
        if (!photo) {
          return JSON.stringify({
            status: 'needs_photo',
            message:
              'Для редактирования прикрепите фотографию к текущему сообщению или ответьте на сообщение с фотографией.',
          });
        }
      }

      const stopActivity = context.startActivity?.();
      try {
        const prompt = input.prompt.trim();
        const image =
          action === 'generate'
            ? await service.generate(prompt)
            : await service.edit(photo as PhotoAttachment, prompt);
        const caption =
          action === 'generate'
            ? 'Готово! Вот изображение по твоему описанию.'
            : 'Готово! Вот преобразованное изображение.';
        await context.sendPhoto(image, caption);
        await context.recordUsage(action === 'generate' ? 'image_generate' : 'image_edit');
        context.onImageSent();
        return JSON.stringify({
          status: 'result',
          action,
          message: 'Изображение отправлено в текущий диалог.',
        });
      } catch (error) {
        const imageError = getSafeImageErrorDetails(error);
        const safetyRejected = imageError.code === 'moderation_blocked';
        const logDetails = {
          error: imageError,
          peerId: context.peerId,
          senderId: context.senderId,
          provider: 'openai',
          model: config.OPENAI_IMAGE_MODEL,
        };
        if (safetyRejected) {
          logger.warn(logDetails, 'Image tool request rejected by safety system');
        } else {
          logger.error(logDetails, 'Image tool request failed');
        }
        return JSON.stringify({
          status: 'error',
          message: safetyRejected
            ? 'Запрос на изображение отклонён системой безопасности. Измените описание и попробуйте снова.'
            : imageError.code === 917
              ? 'Сообщество VK не имеет доступа к этой беседе. Проверьте, что сообщество добавлено в чат.'
              : `Не удалось создать или преобразовать изображение моделью ${config.OPENAI_IMAGE_MODEL}.`,
        });
      } finally {
        stopActivity?.();
      }
    },
  };
}
