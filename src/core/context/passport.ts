import type { PassportSection } from '../../contracts/chat-passport';
import { ownNameText } from '../message-router/name-address';

const signs = [
  [
    'rules',
    /(?:^| )(?:правил\p{L}*|разрешен\p{L}*|запрещ\p{L}*|реклам\p{L}*|спам\p{L}*|модерац\p{L}*|нарушен\p{L}*)(?: |$)|(?:^| )можно(?: ли)? (?:здесь|тут|сюда|в (?:беседе|чате))(?: |$)/u,
  ],
  [
    'glossary',
    /(?:^| )(?:глоссар\p{L}*|значение слова|что (?:значит|означает|понимают)|как (?:у нас )?понимать|местн\p{L}* (?:слово|выражение|термин)|расшифруй\p{L}*)(?: |$)/u,
  ],
  [
    'topic',
    /(?:^| )(?:тем[ауы] (?:(?:этой|этого) )?(?:бесед\p{L}*|чат\p{L}*)|о чем (?:этот чат|эта беседа|здесь говорят)|что (?:у нас |здесь )?обсуждают)(?: |$)/u,
  ],
  [
    'traditions',
    /(?:^| )(?:традици\p{L}*|обыча\p{L}*|ритуал\p{L}*|как (?:здесь|у нас) принято)(?: |$)/u,
  ],
  [
    'events',
    /(?:^| )(?:событи\p{L}*|мероприяти\p{L}*|когда (?:будет |следующая )?встреча|что важного (?:здесь |у нас )?произошло)(?: |$)/u,
  ],
] as const satisfies readonly (readonly [PassportSection, RegExp])[];

export function passportCandidates(text: string): readonly PassportSection[] {
  const words =
    ownNameText(text)
      .match(/[\p{L}\p{N}]+/gu)
      ?.join(' ') ?? '';
  return signs.filter(([, match]) => match.test(words)).map(([section]) => section);
}
