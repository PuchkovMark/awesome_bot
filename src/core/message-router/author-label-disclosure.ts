const labelToken = /(?<![\p{L}\p{N}])u[1-9]\d*(?![\p{L}\p{N}])/giu;
const internalLabel =
  /authorlabel|(?:внутренн|служебн)\p{L}*\s+(?:метк|номер|идентификатор)\p{L}*/iu;
const subjectBefore =
  /(?:^|[^\p{L}\p{N}])(?:микросхем\p{L}*|компонент\p{L}*|разъ[ёе]м\p{L}*|chip|component|connector)\s+[«"'“\x60]?$/iu;
const subjectAfter =
  /^[»"'”\x60]?\s+(?:на (?:схеме|плате)|on (?:the )?(?:board|schematic))(?!\p{L})/iu;

function normalized(text: string) {
  return text.normalize('NFKC').replace(/\p{Cf}/gu, '');
}

function subjectReference(text: string, match: RegExpMatchArray) {
  const token = match[0];
  const index = match.index ?? 0;
  return (
    token.startsWith('U') &&
    (subjectBefore.test(text.slice(Math.max(0, index - 48), index)) ||
      subjectAfter.test(text.slice(index + token.length, index + token.length + 48)))
  );
}

export function disclosesAuthorLabel(
  answer: string,
  question: string,
  authorLabels: readonly string[],
): boolean {
  if (authorLabels.length === 0) return false;
  const issued = new Set(authorLabels);
  const response = normalized(answer);
  const matches = [...response.matchAll(labelToken)].filter((match) =>
    issued.has(match[0].toLowerCase()),
  );
  if (matches.length === 0) return false;
  const source = normalized(question);
  if (internalLabel.test(source) || internalLabel.test(response)) return true;
  const subjectLabels = new Set(
    [...source.matchAll(labelToken)]
      .filter((match) => subjectReference(source, match))
      .map((match) => match[0]),
  );
  return matches.some(
    (match) => !subjectLabels.has(match[0]) || !subjectReference(response, match),
  );
}
