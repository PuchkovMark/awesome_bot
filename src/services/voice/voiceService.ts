import axios from 'axios';
import OpenAI from 'openai';
import { toFile } from 'openai/uploads';
import type { AudioMessageAttachment } from 'vk-io';
import config from '../../config/index.js';

const MAX_AUDIO_BYTES = 24 * 1024 * 1024;
const allowedHosts = [
  'vk.com',
  'userapi.com',
  'userapi.ru',
  'vkuserphoto.ru',
  'vkuserphoto.com',
  'vkuserphoto.net',
];

export const availableVoices = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'onyx',
  'nova',
  'sage',
  'shimmer',
  'verse',
] as const;

export type VoiceName = (typeof availableVoices)[number];

export function isVoiceName(value: string): value is VoiceName {
  return availableVoices.includes(value as VoiceName);
}

/**
 * Преобразует голосовые сообщения в текст и формирует озвученные ответы бота.
 */
export class VoiceService {
  private readonly client: OpenAI | undefined = config.OPENAI_API_KEY
    ? new OpenAI({
        apiKey: config.OPENAI_API_KEY,
        maxRetries: config.AI_MAX_RETRIES,
        timeout: 90_000,
      })
    : undefined;

  async transcribe(attachment: AudioMessageAttachment): Promise<string> {
    const client = this.getClient();
    let url = attachment.mp3Url;
    if (!url) {
      await attachment.loadAttachmentPayload();
      url = attachment.mp3Url;
    }
    if (!url) throw new Error('VK voice message has no downloadable MP3 URL');

    const parsedUrl = new URL(url);
    if (
      parsedUrl.protocol !== 'https:' ||
      !allowedHosts.some(
        (host) => parsedUrl.hostname === host || parsedUrl.hostname.endsWith(`.${host}`),
      )
    ) {
      throw new Error('VK audio URL has an unsupported host');
    }
    const response = await axios.get<ArrayBuffer>(parsedUrl.toString(), {
      responseType: 'arraybuffer',
      timeout: 30_000,
      maxContentLength: MAX_AUDIO_BYTES,
      maxBodyLength: MAX_AUDIO_BYTES,
      maxRedirects: 0,
    });
    const audio = Buffer.from(response.data);
    if (audio.length === 0 || audio.length > MAX_AUDIO_BYTES) {
      throw new Error('VK audio is empty or exceeds the supported size limit');
    }

    const file = await toFile(audio, 'voice.mp3', { type: 'audio/mpeg' });
    const transcription = await client.audio.transcriptions.create({
      file,
      model: config.OPENAI_TRANSCRIPTION_MODEL,
    });
    const text = transcription.text.trim();
    if (!text) throw new Error('OpenAI returned an empty voice transcription');
    return text;
  }

  async synthesize(text: string, voice: string): Promise<Buffer> {
    if (text.length > 4096) throw new Error('Voice response exceeds the 4096-character limit');
    if (!isVoiceName(voice)) throw new Error('Unsupported voice');
    const response = await this.getClient().audio.speech.create({
      model: config.OPENAI_TTS_MODEL,
      voice,
      input: text,
      response_format: 'opus',
      instructions:
        'Speak clearly and naturally in the language of the text at a slightly faster-than-normal pace. Keep pauses concise without rushing.',
    });
    const audio = Buffer.from(await response.arrayBuffer());
    if (audio.length === 0 || audio.length > MAX_AUDIO_BYTES) {
      throw new Error('OpenAI returned empty or oversized generated audio');
    }
    return audio;
  }

  private getClient(): OpenAI {
    if (!config.VOICE_ENABLED) throw new Error('Voice features are disabled');
    if (!this.client) throw new Error('OPENAI_API_KEY must be configured for voice features');
    return this.client;
  }
}

const voiceService = new VoiceService();
export default voiceService;
