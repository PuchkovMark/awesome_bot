import { llmRecovery } from './048-llm-recovery';
import { questionnairePresentation } from './047-questionnaire-presentation';
import { questionnaireHistory } from './046-questionnaire-history';
import { questionnaireProfile } from './045-questionnaire-profile';
import { starterPersonas } from './044-starter-personas';
import { summaryBudget } from './043-summary-budget';
import { chatSummaries } from './042-chat-summaries';
import { questionnaireProgress } from './036-questionnaire-progress';
import { participantDepartures } from './037-participant-departures';
import { questionnaireDelivery } from './038-questionnaire-delivery';
import { profileInferenceRejections } from './041-profile-inference-rejections';
import { profileUpdateBudget } from './040-profile-update-budget';
import { profileUpdateQueue } from './039-profile-update-queue';
import { questionnaireTemplate } from './035-questionnaire-template';
import { chatPassport } from './034-chat-passport';
import { profileCommands } from './032-profile-commands';
import { questionnaireInvitations } from './033-questionnaire-invitations';
import { memberGreetings } from './031-member-greetings';
import { toolAnswerSubjects } from './030-tool-answer-subjects';
import { profileFactEvents } from './029-profile-fact-events';
import { delegationFinalBudget } from './028-delegation-final-budget';
import { addressPreferences } from './027-address-preferences';
import { participantRegistry } from './026-participant-registry';
import { personalReminders } from './024-personal-reminders';
import { personalData } from './025-personal-data';
import { autonomousReplies } from './023-autonomous-replies';
import { chatAuthorLabels } from './022-chat-author-labels';
import { connectionPauseReason } from './021-connection-pause-reason';
import { chatTokenBudget } from './020-chat-token-budget';
import { responseRateAndFlood } from './019-response-rate-and-flood';
import { chatHistoryRetention } from './018-chat-history-retention';
import { chatControl } from './016-chat-control';
import { chatLimits } from './017-chat-limits';
import { adminRecovery } from './015-admin-recovery';
import { chatDisclosure } from './014-chat-disclosure';
import { membershipSignalDeduplication } from './013-membership-signal-deduplication';
import { responseTraces } from './012-response-traces';
import { removeLegacyChatPrompt } from './011-remove-legacy-chat-prompt';
import { contextOrderIndex } from './010-context-order-index';
import { contextInput } from './009-context-input';
import { messageRouting } from './008-message-routing';
import { chatQueue } from './007-chat-queue';
import { versionedContent } from './006-versioned-content';
import { chatConnectionLifecycle } from './005-chat-connection-lifecycle';
import { botAdministration } from './004-bot-administration';
import { journalAndChats } from './001-journal-and-chats';
import { messagesFts } from './002-messages-fts';
import { participantsAndProfiles } from './003-participants-and-profiles';
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}
export const migrations: readonly Migration[] = [
  journalAndChats,
  messagesFts,
  participantsAndProfiles,
  botAdministration,
  chatConnectionLifecycle,
  versionedContent,
  chatQueue,
  messageRouting,
  contextInput,
  contextOrderIndex,
  removeLegacyChatPrompt,
  responseTraces,
  membershipSignalDeduplication,
  chatDisclosure,
  adminRecovery,
  chatControl,
  chatLimits,
  chatHistoryRetention,
  responseRateAndFlood,
  chatTokenBudget,
  connectionPauseReason,
  chatAuthorLabels,
  autonomousReplies,
  personalReminders,
  personalData,
  participantRegistry,
  addressPreferences,
  delegationFinalBudget,
  profileFactEvents,
  toolAnswerSubjects,
  memberGreetings,
  profileCommands,
  questionnaireInvitations,
  chatPassport,
  questionnaireTemplate,
  questionnaireProgress,
  participantDepartures,
  questionnaireDelivery,
  profileUpdateQueue,
  profileUpdateBudget,
  profileInferenceRejections,
  chatSummaries,
  summaryBudget,
  starterPersonas,
  questionnaireProfile,
  questionnaireHistory,
  questionnairePresentation,
  llmRecovery,
];
