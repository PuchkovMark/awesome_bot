import { setTimeout as delay } from 'node:timers/promises';
import type { ChatId, ConnectionScope } from '../contracts/index';
import { StorageError } from '../storage/errors';

interface RefreshOptions {
  readonly signal: AbortSignal;
  readonly activeGroups: () => readonly ChatId[];
  readonly scopeFor: (chatId: ChatId) => ConnectionScope;
  readonly isCurrent: (scope: ConnectionScope) => boolean;
  readonly refresh: (
    scope: ConnectionScope,
    signal: AbortSignal,
    isCurrent: () => boolean,
  ) => Promise<boolean>;
  readonly scanMs: number;
  readonly staggerMs: number;
  readonly confirmed?: () => void;
}

interface ChatRefresh {
  scope: ConnectionScope;
  dueAt: number | null;
  requested: boolean;
  controller: AbortController | undefined;
}

const hourMs = 3_600_000;

function offset(chatId: ChatId, window: number) {
  let hash = 0;
  for (const unit of chatId) hash = (Math.imul(hash, 31) + unit.charCodeAt(0)) >>> 0;
  return window ? hash % window : 0;
}

export function createParticipantSync(options: RefreshOptions) {
  const { signal, isCurrent } = options;
  const cells = new Map<ChatId, ChatRefresh>();
  const operations = new Set<Promise<unknown>>();

  function start(cell: ChatRefresh) {
    if (signal.aborted || !cell.requested || cell.controller || !isCurrent(cell.scope)) return;
    const scope = cell.scope;
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const now = Date.now();
    const delayMs = cell.dueAt === null ? offset(scope.chatId, options.staggerMs) : 0;
    cell.dueAt = now + hourMs - delayMs;
    cell.requested = false;
    cell.controller = controller;
    const operation = options
      .refresh(scope, combined, () => !combined.aborted && isCurrent(scope))
      .then((complete) => {
        if (complete && !combined.aborted && isCurrent(scope)) options.confirmed?.();
      })
      .catch(() => {
        /* Сведения прежней сверки сохраняются. Новый запрос начинается по одному из триггеров. */
      })
      .finally(() => {
        operations.delete(operation);
        cell.controller = undefined;
        start(cell);
      });
    operations.add(operation);
  }

  function attach(scope: ConnectionScope) {
    let cell = cells.get(scope.chatId);
    if (!cell) {
      cell = { scope, requested: true, controller: undefined, dueAt: null };
      cells.set(scope.chatId, cell);
    } else if (!isCurrent(cell.scope)) {
      cell.controller?.abort();
      cell.scope = scope;
      cell.requested = true;
      cell.dueAt = null;
    }
    return cell;
  }

  return Object.freeze({
    request(scope: ConnectionScope) {
      if (signal.aborted || !isCurrent(scope)) return;
      const cell = attach(scope);
      cell.requested = true;
      start(cell);
    },
    async run() {
      try {
        while (!signal.aborted) {
          const active = new Set(options.activeGroups());
          for (const [chatId, cell] of cells) {
            if (active.has(chatId)) continue;
            cell.requested = false;
            cell.controller?.abort();
            if (!cell.controller) cells.delete(chatId);
          }
          const now = Date.now();
          for (const chatId of active) {
            let scope: ConnectionScope;
            try {
              scope = options.scopeFor(chatId);
            } catch (error) {
              if (
                error instanceof StorageError &&
                (error.code === 'stale_scope' || error.code === 'uncertain_connection')
              )
                continue;
              throw error;
            }
            const cell = attach(scope);
            if (cell.dueAt !== null && cell.dueAt <= now && !cell.controller) cell.requested = true;
            start(cell);
          }
          await delay(options.scanMs, undefined, { signal }).catch((error: unknown) => {
            if (!signal.aborted) throw error;
          });
        }
      } finally {
        for (const cell of cells.values()) {
          cell.requested = false;
          cell.controller?.abort();
        }
        await Promise.all(operations);
      }
    },
  });
}
