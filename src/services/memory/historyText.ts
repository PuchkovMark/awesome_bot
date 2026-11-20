/** Remove emoji sequences while preserving ordinary text and punctuation. */
export function cleanHistoryText(text: string): string {
  return text
    .replaceAll(/[#*0-9]\uFE0F?\u20E3/gu, '')
    .replaceAll(/\p{Regional_Indicator}{2}/gu, '')
    .replaceAll(
      /\p{Extended_Pictographic}(?:[\uFE0E\uFE0F]|\p{Emoji_Modifier}|[\u{E0020}-\u{E007F}])*(?:\u200D\p{Extended_Pictographic}(?:[\uFE0E\uFE0F]|\p{Emoji_Modifier}|[\u{E0020}-\u{E007F}])*)*/gu,
      '',
    )
    .replaceAll(/\p{Emoji_Presentation}|\p{Emoji_Modifier}/gu, '')
    .trim();
}
