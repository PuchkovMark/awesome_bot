export function questionnaireListText(
  pairs: readonly { readonly question: string; readonly answer: string }[],
  heading: string,
) {
  return [heading, ...pairs.map(({ question, answer }) => `${question}\n${answer}`)].join('\n\n');
}
