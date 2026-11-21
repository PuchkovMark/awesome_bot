import { journalAndChats } from './001-journal-and-chats.js';
import { messagesFts } from './002-messages-fts.js';
export interface Migration { readonly version: number; readonly name: string; readonly sql: string }
export const migrations: readonly Migration[] = [journalAndChats, messagesFts];
