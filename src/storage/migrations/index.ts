import { chatQueue } from './007-chat-queue.js';
import { versionedContent } from './006-versioned-content.js';
import { chatConnectionLifecycle } from './005-chat-connection-lifecycle.js';
import { botAdministration } from './004-bot-administration.js';
import { journalAndChats } from './001-journal-and-chats.js';
import { messagesFts } from './002-messages-fts.js';
import { participantsAndProfiles } from './003-participants-and-profiles.js';
export interface Migration { readonly version: number; readonly name: string; readonly sql: string }
export const migrations: readonly Migration[] = [journalAndChats, messagesFts, participantsAndProfiles, botAdministration, chatConnectionLifecycle, versionedContent, chatQueue];
