import type { UserId } from '../contracts/identifiers';
import type { RuntimeTool } from './registry';

export interface PublicParticipant {
  user: UserId;
  name: string;
  present: boolean;
  address?: string;
  /** Только действующие собственные утверждения, открытые для данной аудитории. */
  interests: readonly string[];
  facts?: readonly { fieldKey: string; value: string; sourceKind: string; reliability: string }[];
  sourceIds: readonly number[];
}
export interface PublicRoster {
  complete: boolean;
  members: readonly PublicParticipant[];
  matches?: ReadonlySet<UserId>;
  describe?: (
    user: UserId,
  ) => Pick<PublicParticipant, 'interests' | 'facts'> & { sourceIds?: readonly number[] };
  current?: () => boolean;
}
export function participantTools(
  roster: (interest?: string) => PublicRoster,
  anchors: ReadonlyMap<string, UserId>,
  permitted: () => boolean,
) {
  const shown = new Map<UserId, string>();
  const compare = new Intl.Collator('ru', { sensitivity: 'base' });
  type Mode = 'participant_card' | 'participant_search' | 'participant_list';
  function select(mode: Mode, args: Record<string, unknown>, prior: ReadonlyMap<UserId, string>) {
    const query = String(args.query ?? '')
      .trim()
      .toLocaleLowerCase('ru');
    const view = roster(mode === 'participant_search' ? query : undefined);
    const ref = String(args.ref ?? '');
    let subject = anchors.get(ref) ?? [...prior].find(([, key]) => key === ref)?.[0];
    if (subject && !anchors.has(ref)) {
      const selected = view.members.find((person) => person.user === subject);
      if (
        selected &&
        view.members.some(
          (person) =>
            person.user !== subject &&
            person.present &&
            compare.compare(person.name, selected.name) === 0,
        )
      )
        subject = undefined;
    }
    const matches = view.members.filter((p) =>
      mode === 'participant_card'
        ? subject === p.user
        : p.present &&
          (mode === 'participant_list' ||
            view.matches?.has(p.user) ||
            [p.name, p.address ?? '', ...p.interests].some((v) =>
              v.toLocaleLowerCase('ru').includes(query),
            )),
    );
    matches.sort(
      (a, b) => compare.compare(a.name, b.name) || (a.user < b.user ? -1 : Number(a.user > b.user)),
    );
    const limit = mode === 'participant_card' ? 1 : Math.min(Number(args.limit ?? 5), 10);
    const next = new Map(prior);
    const rows: { ref: string; name: string; address?: string; interests: readonly string[] }[] =
      [];
    const subjects: UserId[] = [];
    const ids = new Set<number>();
    let limited = false;
    for (const p of matches) {
      if (rows.length >= limit) {
        limited = true;
        break;
      }
      let key = next.get(p.user);
      if (!key) {
        if (next.size >= 10) {
          limited = true;
          continue;
        }
        key = 'participant' + (next.size + 1);
        next.set(p.user, key);
      }
      subjects.push(p.user);
      const detail = mode === 'participant_card' ? (view.describe?.(p.user) ?? p) : undefined;
      rows.push({
        ref: key,
        name: p.name,
        ...(p.address ? { address: p.address } : {}),
        interests: detail?.interests ?? [],
        ...(detail?.facts ? { facts: detail.facts } : {}),
      });
      for (const id of [...p.sourceIds, ...(detail?.sourceIds ?? [])]) ids.add(id);
    }
    const text = JSON.stringify({
      participants: rows,
      limited,
      incomplete: !view.complete,
      ...(mode === 'participant_card' && !subject
        ? { clarify: 'Попроси ответить на сообщение нужного человека или упомянуть его.' }
        : {}),
    });
    return { text, next, ids: [...ids], subjects, current: view.current };
  }
  function definition(name: Mode, description: string): RuntimeTool {
    return {
      name,
      description,
      access: 'read',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties:
          name === 'participant_card'
            ? { ref: { type: 'string', minLength: 1 } }
            : name === 'participant_search'
              ? { query: { type: 'string', minLength: 1 }, limit: { type: 'integer', minimum: 1 } }
              : { limit: { type: 'integer', minimum: 1 } },
        required:
          name === 'participant_card' ? ['ref'] : name === 'participant_search' ? ['query'] : [],
      },
      async execute(args) {
        if (!permitted()) throw Error();
        const prior = new Map(shown);
        const result = select(name, args, prior);
        for (const [id, key] of result.next) shown.set(id, key);
        return {
          text: result.text,
          sourceIds: result.ids,
          subjectIds: result.subjects,
          current() {
            if (!permitted() || result.current?.() === false) return false;
            const latest = select(name, args, prior);
            return (
              latest.text === result.text &&
              latest.ids.join(',') === result.ids.join(',') &&
              [...result.next].every(([id, key]) => latest.next.get(id) === key)
            );
          },
        };
      },
    };
  }
  return {
    definitions: [
      definition(
        'participant_card',
        'Карточка по ссылке current (автор), reply (цитата), mention1 и далее (упоминания по порядку) или ссылке результата. При тёзках уточни человека. Служебную ссылку не публикуй.',
      ),
      definition(
        'participant_search',
        'Найти известных участников по публичному имени, обращению или доступному интересу. При тёзках попроси уточнить.',
      ),
      definition('participant_list', 'Показать ограниченный список присутствующих в этой беседе.'),
    ],
    labels: () => [...shown.values()],
  };
}
