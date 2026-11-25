import { unquotedParts } from '../author-text';

const recapIntent =
  /(?:что (?:у нас |здесь |в чате )?(?:было(?! бы)|обсуждали|произошло)|перескажи|(?:сделай|дай) сводку|подведи итоги)(?!\p{L})/u;
const otherObject = /перескажи\s+(?:шутку|книгу|фильм|рассказ|сюжет|анекдот)(?!\p{L})/u;

export function isRecapRequest(text: string) {
  const parts = unquotedParts(text);
  return (
    parts.some((part) => recapIntent.test(part)) && !parts.some((part) => otherObject.test(part))
  );
}
