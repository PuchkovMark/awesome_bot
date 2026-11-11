export const MIN_AUTO_VOICE_CHARACTERS = 500;
export const MAX_VOICE_TEXT_LENGTH = 4096;

export function isLongEnoughForAutomaticVoice(text: string): boolean {
  return Array.from(text).length > MIN_AUTO_VOICE_CHARACTERS;
}
