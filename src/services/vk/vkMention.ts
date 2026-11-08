export type VkUserReference = { kind: 'id'; value: string } | { kind: 'screenName'; value: string };

export function parseVkUserReference(input: string): VkUserReference | null {
  let value = input.trim();
  const profileUrl = value.match(/^https?:\/\/(?:www\.)?vk\.com\/([^/?#]+)\/?$/iu);
  if (profileUrl?.[1]) value = profileUrl[1];

  const markup = value.match(/^\[(?:id)?(\d+)\|[^\]]+\]$/u);
  if (markup?.[1]) return { kind: 'id', value: markup[1] };

  const idMention = value.match(/^@?id(\d+)(?:\s+\([^)]*\))?$/iu);
  if (idMention?.[1]) return { kind: 'id', value: idMention[1] };

  if (/^\d+$/u.test(value)) return { kind: 'id', value };

  const screenName = value.match(/^@?([a-z][a-z\d_.]*)$/iu);
  if (screenName?.[1]) return { kind: 'screenName', value: screenName[1] };

  return null;
}
