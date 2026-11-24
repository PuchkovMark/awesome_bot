export function isRecapRequest(text: string) {
  const request = text.toLocaleLowerCase('ru').replace(/ё/g, 'е');
  const recapIntent =
    /(?:что (?:у нас |здесь |в чате )?(?:было(?! бы)|обсуждали|произошло)|перескажи|(?:сделай|дай) сводку|подведи итоги)(?!\p{L})/u;
  if (!recapIntent.test(request)) return false;
  if (/перескажи\s+(?:шутку|книгу|фильм|рассказ|сюжет|анекдот)(?!\p{L})/u.test(request))
    return false;
  return true;
}
