import type { Database } from 'better-sqlite3';
import type { ConnectionScope, UserId } from '../contracts/index';
import {
  eraseDepartedProfile,
  participantProfileAvailable,
  pauseDepartedActivity,
  purgeDepartedProfiles,
  readDeparture,
  type ParticipantDeparture,
} from './participant-departures';
import { hideDepartedAnswers, releaseDepartedAnswers } from './participant-derived-data';

type ChatGeneration = Pick<ConnectionScope, 'chatId' | 'generation'>;
interface Subject extends ChatGeneration {
  readonly user: UserId;
}
interface MemberEvidence {
  readonly status: 'present' | 'left' | 'removed' | 'absent' | 'unknown';
  readonly observedAt: number | null;
  readonly joinedAt: number | null;
}

const emptyDeparture: ParticipantDeparture = {
  revision: 1,
  departedAt: null,
  returnedAt: null,
  purgedAt: null,
  profileEpoch: 0,
  needsVerification: 1,
};

function evidence(db: Database, subject: Subject) {
  return db
    .prepare(
      `SELECT status,status_observed_at AS observedAt,joined_at AS joinedAt
    FROM chat_participants WHERE chat_id=@chatId AND user_id=@user`,
    )
    .get(subject) as MemberEvidence | undefined;
}

function updateEvidence(db: Database, subject: Subject, member: MemberEvidence) {
  db.prepare(
    `INSERT INTO chat_participants(chat_id,user_id,joined_at,role,status,status_observed_at)
    VALUES(@chatId,@user,@joinedAt,'unknown',@status,@observedAt)
    ON CONFLICT(chat_id,user_id) DO UPDATE SET
      joined_at=excluded.joined_at,status=excluded.status,status_observed_at=excluded.status_observed_at,
      role='unknown',role_observed_at=NULL
    WHERE (status,status_observed_at,joined_at) IS NOT
          (excluded.status,excluded.status_observed_at,excluded.joined_at)`,
  ).run({ ...subject, ...member });
}

function storeDeparture(db: Database, subject: Subject, row: ParticipantDeparture) {
  db.prepare(
    `INSERT INTO participant_departures (
    chat_id,generation,user_id,revision,departed_at,returned_at,purged_at,profile_epoch,needs_verification)
    VALUES(@chatId,@generation,@user,@revision,@departedAt,@returnedAt,@purgedAt,@profileEpoch,@needsVerification)
    ON CONFLICT(chat_id,generation,user_id) DO UPDATE SET
      revision=excluded.revision,departed_at=excluded.departed_at,returned_at=excluded.returned_at,
      purged_at=excluded.purged_at,profile_epoch=excluded.profile_epoch,needs_verification=excluded.needs_verification`,
  ).run({ ...subject, ...row });
}

/** Принимаются только технические сведения того же подключения, в обеих транзакциях. */
export function reconcileStagedDepartures(staged: Database, newer: Database, now: number) {
  const hasDepartureEvidence = newer
    .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='participant_departures'")
    .get();
  const subjects = staged
    .prepare(
      `WITH candidates(chat_id,generation,user_id) AS (
      SELECT c.chat_id,c.generation,p.user_id FROM chat_participants p JOIN chat_connections c USING(chat_id)
      UNION SELECT chat_id,generation,user_id FROM participant_departures
      UNION SELECT chat_id,generation,user_id FROM address_preferences
      UNION SELECT chat_id,generation,user_id FROM questionnaire_progress
      UNION SELECT c.chat_id,c.generation,s.user_id FROM tool_answer_subjects s
        JOIN messages m ON m.id=s.answer_id JOIN chat_connections c USING(chat_id)
    ) SELECT chat_id AS chatId,generation,user_id AS user FROM candidates c
    WHERE NOT EXISTS(SELECT 1 FROM personal_deletions d
      WHERE (d.chat_id,d.generation,d.user_id)=(c.chat_id,c.generation,c.user_id) AND d.confirmed_at IS NOT NULL)`,
    )
    .all() as Subject[];
  for (const subject of subjects) {
    const { user } = subject;
    const saved = readDeparture(staged, subject, user);
    const savedMember = evidence(staged, subject);
    const recent = hasDepartureEvidence ? readDeparture(newer, subject, user) : undefined;
    const recentMember = hasDepartureEvidence ? evidence(newer, subject) : undefined;
    const acceptsEvidence =
      recentMember?.observedAt != null &&
      recentMember.observedAt <= now &&
      recentMember.observedAt >= (savedMember?.observedAt ?? 0);
    const verifiedPresent = acceptsEvidence && recentMember.status === 'present';
    let next: ParticipantDeparture | undefined;
    if (
      recent &&
      recent.revision >= (saved?.revision ?? 0) &&
      recent.profileEpoch >= (saved?.profileEpoch ?? 0)
    ) {
      // Очистка при сверке наступает и тогда, когда свежая БД ещё ждёт своего таймера.
      next = {
        ...recent,
        needsVerification: Number(
          recent.needsVerification === 1 || (recent.returnedAt !== null && !verifiedPresent),
        ),
      };
    } else if (
      !recent &&
      verifiedPresent &&
      (!saved || (saved.departedAt === null && saved.profileEpoch === 0))
    ) {
      if (saved) next = { ...saved, returnedAt: recentMember.observedAt, needsVerification: 0 };
    } else {
      next =
        saved && !participantProfileAvailable(saved)
          ? saved
          : { ...(saved ?? emptyDeparture), needsVerification: 1 };
    }
    if (next) {
      storeDeparture(staged, subject, next);
      if (next.profileEpoch > (saved?.profileEpoch ?? 0))
        eraseDepartedProfile(staged, subject, user);
      else if (!participantProfileAvailable(next)) {
        pauseDepartedActivity(staged, subject, user);
        hideDepartedAnswers(staged, subject, user);
      } else if (next.revision !== saved?.revision) {
        pauseDepartedActivity(staged, subject, user);
      }
      if (participantProfileAvailable(next)) releaseDepartedAnswers(staged, subject, user);
    }
    if (acceptsEvidence && (!next || !next.needsVerification))
      updateEvidence(staged, subject, recentMember);
  }
  // Скопированные ключи и полная сверка ограничивают запоздавшие сигналы из старой копии.
  if (hasDepartureEvidence) {
    const installEvent = staged.prepare(
      `INSERT OR IGNORE INTO participant_events
      SELECT chat_id,generation,@event FROM chat_connections WHERE chat_id=@chatId AND generation=@generation`,
    );
    for (const row of newer
      .prepare('SELECT chat_id AS chatId,generation,event_key AS event FROM participant_events')
      .iterate() as Iterable<ChatGeneration & { event: string }>)
      installEvent.run(row);
    const installSnapshotBoundary = staged.prepare(
      `INSERT INTO participant_sync (chat_id,generation,last_complete_started_at,last_complete_at)
      SELECT chat_id,generation,@startedAt,@completeAt FROM chat_connections
      WHERE chat_id=@chatId AND generation=@generation
      ON CONFLICT(chat_id,generation) DO UPDATE SET
        last_complete_started_at=excluded.last_complete_started_at,
        last_complete_at=excluded.last_complete_at,needs_sync=1
      WHERE coalesce(last_complete_at,-1)<excluded.last_complete_at`,
    );
    for (const row of newer
      .prepare(
        `SELECT chat_id AS chatId,generation,last_complete_started_at AS startedAt,last_complete_at AS completeAt
      FROM participant_sync WHERE last_complete_started_at IS NOT NULL AND last_complete_at<=?`,
      )
      .all(now) as (ChatGeneration & { startedAt: number; completeAt: number })[])
      installSnapshotBoundary.run(row);
  }

  while (purgeDepartedProfiles(staged, now) > 0) {
    /* Копия остаётся изолированной до проверки всех порций. */
  }
}
