import { logger } from '../../logger/index.js';
import senderService, { isChatPeer } from '../sender/senderService.js';
import splitterService from '../splitter/splitterService.js';
import voiceService from './voiceService.js';

export const VOICE_FAILURE_NOTICE = '\n\n[Не удалось озвучить ответ.]';

type ReplyOptions = {
  replyTo?: number;
  conversationMessageId?: number;
};

export type VoiceResponseOptions = {
  peerId: number;
  text: string;
  voice?: string;
  options?: ReplyOptions;
  keyboard?: string;
  startActivity?: () => () => void;
  recordUsage?: () => Promise<void>;
};

export type VoiceResponseResult = {
  responseText: string;
  voiceSent: boolean;
};

async function recordVoiceUsage(recordUsage?: () => Promise<void>): Promise<void> {
  if (!recordUsage) return;
  try {
    await recordUsage();
  } catch (error) {
    logger.warn(
      { errorName: error instanceof Error ? error.name : 'UnknownError' },
      'Unable to record voice usage',
    );
  }
}

/**
 * Отправляет ответ с озвучкой: в беседе — один текст с голосовым вложением,
 * в личном диалоге — текст частями, к каждой части прикрепляется своё голосовое.
 */
export async function sendVoiceAwareResponse(
  options: VoiceResponseOptions,
): Promise<VoiceResponseResult> {
  const {
    peerId,
    text,
    voice,
    options: replyOptions,
    keyboard,
    startActivity,
    recordUsage,
  } = options;
  if (!text.trim()) throw new Error('Response text is empty');

  if (!voice) {
    const responseText = senderService.formatMessage(peerId, text);
    await senderService.send(peerId, text, {
      ...replyOptions,
      ...(keyboard ? { keyboard } : {}),
    });
    return { responseText, voiceSent: false };
  }

  const stopActivity = startActivity?.();
  try {
    if (isChatPeer(peerId)) {
      const responseText = senderService.formatMessage(peerId, text);
      const spokenText = splitterService.truncate(text, '');
      try {
        const audio = await voiceService.synthesize(spokenText, voice);
        const attachment = await senderService.uploadVoice(peerId, audio);
        await senderService.send(peerId, responseText, {
          ...replyOptions,
          ...(keyboard ? { keyboard } : {}),
          attachment,
        });
        await recordVoiceUsage(recordUsage);
        return { responseText: text, voiceSent: true };
      } catch (error) {
        logger.warn(
          {
            err: error,
            peerId,
            textLength: text.length,
            voiceParts: 1,
          },
          'Failed to generate group voice reply; sending text fallback',
        );
        const fallbackText = senderService.formatMessage(peerId, text, VOICE_FAILURE_NOTICE);
        await senderService.send(peerId, fallbackText, {
          ...replyOptions,
          ...(keyboard ? { keyboard } : {}),
        });
        return { responseText: fallbackText, voiceSent: false };
      }
    }

    const parts = splitterService.split(text).filter((part) => part.trim().length > 0);
    if (parts.length === 0) throw new Error('Voice response has no speakable text');
    let voiceSent = false;
    for (const [index, part] of parts.entries()) {
      const messageOptions = {
        ...(index === 0 ? replyOptions : {}),
        ...(index === 0 && keyboard ? { keyboard } : {}),
      };
      try {
        const audio = await voiceService.synthesize(part, voice);
        const attachment = await senderService.uploadVoice(peerId, audio);
        await senderService.send(peerId, part, {
          ...messageOptions,
          attachment,
        });
        voiceSent = true;
        await recordVoiceUsage(recordUsage);
      } catch (error) {
        logger.warn(
          {
            err: error,
            peerId,
            part: index + 1,
            textLength: part.length,
          },
          'Failed to generate voice part; sending text fallback',
        );
        await senderService.send(peerId, `${part}${VOICE_FAILURE_NOTICE}`, messageOptions);
      }
    }
    return { responseText: text, voiceSent };
  } finally {
    stopActivity?.();
  }
}
