import axios from 'axios';

function isAllowedVkHost(hostname: string): boolean {
  return (
    hostname === 'vk.com' ||
    hostname.endsWith('.vk.com') ||
    hostname.endsWith('.userapi.com') ||
    hostname.endsWith('.userapi.ru') ||
    hostname.endsWith('.vkuserphoto.ru') ||
    hostname.endsWith('.vkuserphoto.com') ||
    hostname.endsWith('.vkuserphoto.net')
  );
}

/**
 * Проверяет, что ссылка на файл VK использует https и принадлежит доверенному хосту.
 */
export function parseAllowedVkFileUrl(rawUrl: string): URL {
  const parsedUrl = new URL(rawUrl);
  const hostname = parsedUrl.hostname.toLowerCase();
  if (
    parsedUrl.protocol !== 'https:' ||
    !isAllowedVkHost(hostname) ||
    parsedUrl.username ||
    parsedUrl.password ||
    (parsedUrl.port && parsedUrl.port !== '443')
  ) {
    throw new Error('VK file URL has an unsupported host');
  }
  return parsedUrl;
}

/**
 * Скачивает файл VK с ограничением размера и без переходов по редиректам.
 */
export async function downloadVkFile(rawUrl: string, maxBytes: number): Promise<Buffer> {
  const parsedUrl = parseAllowedVkFileUrl(rawUrl);
  const response = await axios.get<ArrayBuffer>(parsedUrl.toString(), {
    responseType: 'arraybuffer',
    timeout: 20_000,
    maxContentLength: maxBytes,
    maxBodyLength: maxBytes,
    maxRedirects: 0,
  });
  const data = Buffer.from(response.data);
  if (data.length === 0 || data.length > maxBytes) {
    throw new Error('VK file is empty or exceeds the size limit');
  }
  return data;
}
