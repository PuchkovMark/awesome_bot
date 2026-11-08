import axios from 'axios';
import OpenAI from 'openai';
import { toFile } from 'openai/uploads';
import sharp from 'sharp';
import type { PhotoAttachment } from 'vk-io';
import config from '../../config/index.js';

const MAX_SOURCE_IMAGE_BYTES = 20 * 1024 * 1024;
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

  async generate(prompt: string): Promise<GeneratedImage> {
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

  async edit(photo: PhotoAttachment, prompt: string): Promise<GeneratedImage> {
    const data = await this.downloadPhoto(photo);
    return this.editBuffer(data, prompt);
  }

  async editBuffer(data: Buffer, prompt: string): Promise<GeneratedImage> {
    const sourceImage = await sharp(data)
      .rotate()
      .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer();
    const imageFile = await toFile(sourceImage, 'source.jpg', { type: 'image/jpeg' });
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
    if (!this.openai) {
      throw new Error('OPENAI_API_KEY must be configured for OpenAI image features');
    }
    return this.openai;
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
