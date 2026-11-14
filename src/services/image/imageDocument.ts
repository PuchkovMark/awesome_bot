const IMAGE_DOCUMENT_EXTENSIONS = new Set(['gif', 'jpeg', 'jpg', 'png', 'webp']);

/**
 * Проверяет, что документ VK является изображением и может быть отправлен в анализ.
 */
export function isImageDocumentExtension(extension: string | undefined): boolean {
  return (
    extension !== undefined && IMAGE_DOCUMENT_EXTENSIONS.has(extension.toLocaleLowerCase('en-US'))
  );
}
