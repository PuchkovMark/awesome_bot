import type { IncomingMessage } from '../../contracts/index';
import { ownNameText } from './name-address';

export type InitiativeCause = 'help' | 'free_mention' | 'unanswered';

const danger =
  /(?:^|[^\p{L}])(?:суицид\p{L}*|самоубий\p{L}*|умереть|убь[ею]\p{L}*|уби[тй]\p{L}*|угрожа\p{L}*|оружи\p{L}*|насили\p{L}*|кризис\p{L}*|паник\p{L}*|оскорб\p{L}*|дра[кч]\p{L}*|конфликт\p{L}*|ненавижу|травл\p{L}*)(?!\p{L})/iu;
const venue = '(?:у|возле|около|в|на|рядом с) [а-я][а-я-]*(?: [а-я][а-я-]*){0,3}';
const time = '(?:[01]\\d|2[0-3]):[0-5]\\d';
const meeting = '(?:встречаемся|встреча)';
const asksTime = new RegExp('^во сколько ' + meeting + ' (' + venue + ')\\?$', 'u');
const asksPlace = new RegExp('^где ' + meeting + ' (?:в|к) (' + time + ')\\?$', 'u');
const confirmedMeeting = new RegExp(
  '^' + meeting + ' (' + venue + ') (?:в|к) (' + time + ')[.!]?$',
  'u',
);
const help =
  /^(?:(?:кто[ -]нибудь|кто[ -]то),? )?(?:помогите|подскажите|может помочь)(?: разобраться)? (?:с расписанием|со временем встречи|с местом встречи|с задачей)[.!?]?$/u;
const freeMention =
  /^(?:(?:мы )?(?:обсуждали|обсуждаем),? как (?:работает|помогает) пенек|(?:мы )?говорили о боте пенек|пенек (?:сегодня )?работает)[.!]?$/u;

const normalized = (text: string) =>
  text.normalize('NFC').toLowerCase().replaceAll('ё', 'е').trim().replace(/\s+/gu, ' ');
const ownText = (text: string) => normalized(ownNameText(text.replace(/^\s*>.*$/gmu, '')));
export const sensitiveDialogue = (text: string) => danger.test(normalized(text));

export type MeetingQuestion = { readonly asks: 'time' | 'place'; readonly anchor: string };
export function meetingQuestion(text: string): MeetingQuestion | undefined {
  return parseMeetingQuestion(ownText(text));
}

function parseMeetingQuestion(input: string): MeetingQuestion | undefined {
  const place = asksTime.exec(input)?.[1];
  if (place) return { asks: 'time', anchor: place };
  const clock = asksPlace.exec(input)?.[1];
  return clock ? { asks: 'place', anchor: clock } : undefined;
}

export function meetingAnswer(question: MeetingQuestion, text: string): string | undefined {
  const fact = confirmedMeeting.exec(normalized(text));
  if (!fact) return undefined;
  const [, place, clock] = fact;
  return question.asks === 'time'
    ? place === question.anchor
      ? clock
      : undefined
    : clock === question.anchor
      ? place
      : undefined;
}

export function meetingChanged(question: MeetingQuestion, text: string): boolean {
  const line = normalized(text);
  return (
    line.includes(question.anchor) &&
    /(?:^|[^\p{L}])(?:встреч\p{L}*|сбор\p{L}*)(?!\p{L})/u.test(line) &&
    /(?:^|[^\p{L}])(?:отмен\p{L}*|перенес\p{L}*|перенос\p{L}*|не встречаемся)(?!\p{L})/u.test(line)
  );
}

export function autonomousCause(message: IncomingMessage): InitiativeCause | undefined {
  if (
    message.isBot !== false ||
    !message.isGroupChat ||
    message.replyAddress !== undefined ||
    message.replyToMessageId !== undefined ||
    message.hasOtherAddress ||
    message.attachments.length !== 0 ||
    sensitiveDialogue(message.text)
  )
    return undefined;
  const text = ownText(message.text);
  if (help.test(text)) return 'help';
  if (freeMention.test(text)) return 'free_mention';
  return parseMeetingQuestion(text) ? 'unanswered' : undefined;
}
