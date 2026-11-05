import axios from 'axios';
import OpenAI from 'openai';
import { toFile } from 'openai/uploads';
import sharp from 'sharp';
import type { PhotoAttachment } from 'vk-io';
import config from '../../config/index.js';
import { logger } from '../../logger/index.js';

const MAX_SOURCE_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_EDIT_MODEL = '@cf/black-forest-labs/flux-2-dev';
const allowedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

export type GeneratedImage = {
  buffer: Buffer;
  contentType: 'image/jpeg' | 'image/png' | 'image/webp';
};

export class ImageGenerationService {
  private readonly openai: OpenAI | undefined = config.OPENAI_API_KEY
    ? new OpenAI({
        apiKey: config.OPENAI_API_KEY,
        maxRetries: config.AI_MAX_RETRIES,
        timeout: 120_000,
      })
    : undefined;

  private getEndpoint(model: string): string {
    if (!config.CLOUDFLARE_ACCOUNT_ID || !config.CLOUDFLARE_API_TOKEN) {
      throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be configured');
    }
    return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.CLOUDFLARE_ACCOUNT_ID)}/ai/run/${model}`;
  }

  async generate(prompt: string): Promise<GeneratedImage> {
    if (config.IMAGE_PROVIDER === 'openai') return this.generateWithOpenAI(prompt);
    let input: Record<string, string | number | number[]> | FormData = { prompt };
    if (config.CLOUDFLARE_IMAGE_MODEL === '@cf/black-forest-labs/flux-2-dev') {
      input = new FormData();
      input.append('prompt', prompt);
    }
    return this.runModel(config.CLOUDFLARE_IMAGE_MODEL, input, 'image/jpeg');
  }

  async edit(photo: PhotoAttachment, prompt: string): Promise<GeneratedImage> {
    const data = await this.downloadPhoto(photo);
    if (config.IMAGE_PROVIDER === 'openai') {
      const sourceImage = await sharp(data)
        .rotate()
        .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 90 })
        .toBuffer();
      return this.editWithOpenAI(sourceImage, prompt);
    }

    const resizedImage = await sharp(data)
      .rotate()
      .resize({ width: 511, height: 511, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();
    const { width, height } = await sharp(resizedImage).metadata();
    if (!width || !height) throw new Error('Failed to determine the source image dimensions');
    const outputScale = 1024 / Math.max(width, height);
    const outputWidth = Math.max(256, Math.round(width * outputScale));
    const outputHeight = Math.max(256, Math.round(height * outputScale));

    const form = new FormData();
    form.append('prompt', prompt);
    form.append('steps', '25');
    form.append(
      'input_image_0',
      new Blob([new Uint8Array(resizedImage)], { type: 'image/png' }),
      'source.png',
    );
    form.append('width', String(outputWidth));
    form.append('height', String(outputHeight));

    return this.runModel(IMAGE_EDIT_MODEL, form, 'image/jpeg');
  }

  async downloadPhoto(photo: PhotoAttachment): Promise<Buffer> {
    let imageUrl = photo.largeSizeUrl || photo.mediumSizeUrl;
    if (!imageUrl) {
      await photo.loadAttachmentPayload();
      imageUrl = photo.largeSizeUrl || photo.mediumSizeUrl;
    }
    if (!imageUrl) throw new Error('VK photo does not contain a downloadable image URL');

    const { data } = await this.downloadVkPhoto(imageUrl);
    return data;
  }

  private getOpenAIClient(): OpenAI {
    if (!this.openai)
      throw new Error('OPENAI_API_KEY must be configured for OpenAI image features');
    return this.openai;
  }

  private async generateWithOpenAI(prompt: string): Promise<GeneratedImage> {
    const response = await this.getOpenAIClient().images.generate({
      model: config.OPENAI_IMAGE_MODEL,
      prompt,
      quality: 'high',
      size: '1024x1024',
      n: 1,
    });
    const image = response.data?.[0]?.b64_json;
    if (!image) throw new Error('OpenAI Images API returned no image data');
    const buffer = Buffer.from(image, 'base64');
    if (buffer.length === 0) throw new Error('OpenAI Images API returned an empty image');
    return { buffer, contentType: 'image/png' };
  }

  private async editWithOpenAI(image: Buffer, prompt: string): Promise<GeneratedImage> {
    const imageFile = await toFile(image, 'source.jpg', { type: 'image/jpeg' });
    const response = await this.getOpenAIClient().images.edit({
      model: config.OPENAI_IMAGE_MODEL,
      image: imageFile,
      prompt,
      quality: 'high',
      size: '1024x1024',
      n: 1,
    });
    const output = response.data?.[0]?.b64_json;
    if (!output) throw new Error('OpenAI Images API returned no edited image data');
    const buffer = Buffer.from(output, 'base64');
    if (buffer.length === 0) throw new Error('OpenAI Images API returned an empty edited image');
    return { buffer, contentType: 'image/png' };
  }

  private async runModel(
    model: string,
    input: Record<string, string | number | number[]> | FormData,
    fallbackContentType: GeneratedImage['contentType'],
  ): Promise<GeneratedImage> {
    const endpoint = this.getEndpoint(model);
    let response;
    try {
      response = await this.postWithRetries(endpoint, input);
    } catch (err) {
      if (!axios.isAxiosError(err)) throw err;

      const body = err.response?.data;
      const bodyText =
        typeof body === 'string'
          ? body
          : Buffer.isBuffer(body)
            ? body.toString('utf8')
            : body instanceof ArrayBuffer
              ? Buffer.from(body).toString('utf8')
              : ArrayBuffer.isView(body)
                ? Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8')
                : typeof body === 'object' && body !== null
                  ? JSON.stringify(body)
                  : '';
      let detail = '';
      if (bodyText) {
        try {
          const parsed: unknown = JSON.parse(bodyText);
          if (typeof parsed === 'object' && parsed !== null && 'errors' in parsed) {
            const errors = parsed.errors;
            if (Array.isArray(errors)) {
              detail = errors
                .map((item) =>
                  typeof item === 'object' &&
                  item !== null &&
                  'message' in item &&
                  typeof item.message === 'string'
                    ? item.message
                    : '',
                )
                .filter(Boolean)
                .join('; ');
            }
          }
          if (!detail && typeof parsed === 'object' && parsed !== null && 'messages' in parsed) {
            const messages = parsed.messages;
            if (Array.isArray(messages)) {
              detail = messages
                .filter((message): message is string => typeof message === 'string')
                .join('; ');
            }
          }
        } catch {
          detail = bodyText.slice(0, 500);
        }
      }

      const status = err.response?.status;
      logger.error(
        {
          model,
          status,
          detail: detail.slice(0, 500) || undefined,
          message: err.message,
        },
        'Cloudflare Workers AI request failed',
      );
      throw new Error(
        `Cloudflare Workers AI request failed${status ? ` (${status})` : ''}${detail ? `: ${detail.slice(0, 500)}` : ''}`,
      );
    }

    const contentType = String(response.headers['content-type'] ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    const data = Buffer.from(response.data);
    if (contentType.startsWith('image/')) {
      if (!allowedImageTypes.has(contentType)) {
        throw new Error(`Unsupported generated image content type: ${contentType}`);
      }
      if (
        contentType === 'image/jpeg' ||
        contentType === 'image/png' ||
        contentType === 'image/webp'
      ) {
        return { buffer: data, contentType };
      }
      throw new Error(`Unsupported generated image content type: ${contentType}`);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(data.toString('utf8'));
    } catch (err) {
      throw new Error('Cloudflare Workers AI returned an unrecognized image response', {
        cause: err,
      });
    }

    if (typeof payload !== 'object' || payload === null || !('result' in payload)) {
      throw new Error('Cloudflare Workers AI response does not contain a result');
    }
    const result = payload.result;
    const base64Image =
      typeof result === 'string'
        ? result
        : typeof result === 'object' &&
            result !== null &&
            'image' in result &&
            typeof result.image === 'string'
          ? result.image
          : undefined;
    if (!base64Image) throw new Error('Cloudflare Workers AI returned no generated image');

    const buffer = Buffer.from(base64Image, 'base64');
    if (buffer.length === 0) throw new Error('Cloudflare Workers AI returned an empty image');
    return { buffer, contentType: fallbackContentType };
  }

  private async postWithRetries(
    endpoint: string,
    input: Record<string, string | number | number[]> | FormData,
  ) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await axios.post<ArrayBuffer>(endpoint, input, {
          headers: { Authorization: `Bearer ${config.CLOUDFLARE_API_TOKEN}` },
          responseType: 'arraybuffer',
          timeout: 120_000,
          maxContentLength: MAX_SOURCE_IMAGE_BYTES * 2,
          maxBodyLength: MAX_SOURCE_IMAGE_BYTES * 2,
        });
      } catch (err) {
        if (attempt >= config.AI_MAX_RETRIES || !this.isTransientFailure(err)) throw err;
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
  }

  private isTransientFailure(err: unknown): boolean {
    if (!axios.isAxiosError(err)) return false;
    const status = err.response?.status;
    if (status === 429) {
      const body = err.response?.data;
      const detail =
        typeof body === 'string'
          ? body
          : Buffer.isBuffer(body)
            ? body.toString('utf8')
            : JSON.stringify(body ?? '');
      if (/used up|daily free allocation|upgrade to cloudflare/i.test(detail)) return false;
    }
    return (
      status === 408 ||
      status === 425 ||
      status === 429 ||
      (typeof status === 'number' && status >= 500) ||
      ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ERR_NETWORK'].includes(err.code ?? '')
    );
  }

  private async downloadVkPhoto(url: string): Promise<{ data: Buffer; contentType: string }> {
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname.toLowerCase();
    const allowedHost =
      hostname === 'vk.com' ||
      hostname.endsWith('.vk.com') ||
      hostname.endsWith('.userapi.com') ||
      hostname.endsWith('.userapi.ru') ||
      hostname.endsWith('.vkuserphoto.ru') ||
      hostname.endsWith('.vkuserphoto.com') ||
      hostname.endsWith('.vkuserphoto.net');
    if (parsedUrl.protocol !== 'https:' || !allowedHost) {
      throw new Error('VK photo URL has an unsupported host');
    }

    const response = await axios.get<ArrayBuffer>(parsedUrl.toString(), {
      responseType: 'arraybuffer',
      timeout: 20_000,
      maxContentLength: MAX_SOURCE_IMAGE_BYTES,
      maxBodyLength: MAX_SOURCE_IMAGE_BYTES,
      maxRedirects: 0,
    });
    const contentType = String(response.headers['content-type'] ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    const data = Buffer.from(response.data);
    if (!allowedImageTypes.has(contentType)) {
      throw new Error(`Unsupported VK photo content type: ${contentType || 'unknown'}`);
    }
    if (data.length === 0 || data.length > MAX_SOURCE_IMAGE_BYTES) {
      throw new Error('VK photo is empty or exceeds the supported size limit');
    }
    return { data, contentType };
  }
}

export default new ImageGenerationService();
