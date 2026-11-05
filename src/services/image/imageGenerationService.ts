import axios from 'axios';
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
  private getEndpoint(model: string): string {
    if (!config.CLOUDFLARE_ACCOUNT_ID || !config.CLOUDFLARE_API_TOKEN) {
      throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be configured');
    }
    return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.CLOUDFLARE_ACCOUNT_ID)}/ai/run/${model}`;
  }

  async generate(prompt: string): Promise<GeneratedImage> {
    let input: Record<string, string | number | number[]> | FormData = { prompt };
    if (config.CLOUDFLARE_IMAGE_MODEL === '@cf/black-forest-labs/flux-2-dev') {
      input = new FormData();
      input.append('prompt', prompt);
    }
    return this.runModel(config.CLOUDFLARE_IMAGE_MODEL, input, 'image/jpeg');
  }

  async edit(photo: PhotoAttachment, prompt: string): Promise<GeneratedImage> {
    let imageUrl = photo.largeSizeUrl || photo.mediumSizeUrl;
    if (!imageUrl) {
      await photo.loadAttachmentPayload();
      imageUrl = photo.largeSizeUrl || photo.mediumSizeUrl;
    }
    if (!imageUrl) throw new Error('VK photo does not contain a downloadable image URL');

    const { data } = await this.downloadVkPhoto(imageUrl);
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

  private async runModel(
    model: string,
    input: Record<string, string | number | number[]> | FormData,
    fallbackContentType: GeneratedImage['contentType'],
  ): Promise<GeneratedImage> {
    const endpoint = this.getEndpoint(model);
    let response;
    try {
      response = await axios.post<ArrayBuffer>(endpoint, input, {
        headers: {
          Authorization: `Bearer ${config.CLOUDFLARE_API_TOKEN}`,
          'Content-Type': input instanceof FormData ? 'multipart/form-data' : 'application/json',
        },
        responseType: 'arraybuffer',
        timeout: 120_000,
        maxContentLength: MAX_SOURCE_IMAGE_BYTES * 2,
        maxBodyLength: MAX_SOURCE_IMAGE_BYTES * 2,
      });
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
