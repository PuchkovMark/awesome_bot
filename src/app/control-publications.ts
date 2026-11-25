import type { ConnectionScope, IncomingMessage, UserId } from '../contracts/index';

export type TrackPublication = (work: Promise<unknown>) => void;

interface PendingPrompt {
  readonly scope: ConnectionScope;
  readonly actor: UserId;
  readonly text: string;
  actions: Promise<void>;
  receipt?: string;
}

/** Ожидание действует до завершения отправки. Разрешение на действие хранится в SQLite. */
export function pendingControlPrompts() {
  const sending = new Set<PendingPrompt>();

  async function retire(prompt: PendingPrompt) {
    let actions: Promise<void>;
    do {
      actions = prompt.actions;
      await actions;
    } while (actions !== prompt.actions);
    sending.delete(prompt);
  }

  function matches(scope: ConnectionScope, message: IncomingMessage) {
    if (message.replyAddress !== 'bot' || !message.replyToMessageId) return [];
    return [...sending].filter(
      (prompt) =>
        prompt.scope.chatId === scope.chatId &&
        prompt.scope.generation === scope.generation &&
        (prompt.receipt === undefined
          ? prompt.text === message.botReplyText
          : prompt.receipt === message.replyToMessageId),
    );
  }

  return {
    async send<T>(
      scope: ConnectionScope,
      actor: UserId,
      text: string,
      publish: (receivedId: (id: string) => void) => Promise<T>,
    ) {
      const done = Promise.withResolvers<void>();
      const prompt: PendingPrompt = { scope, actor, text, actions: done.promise };
      sending.add(prompt);
      try {
        return await publish((id) => (prompt.receipt = id));
      } finally {
        done.resolve();
        void retire(prompt);
      }
    },
    has: (scope: ConnectionScope, message: IncomingMessage) => matches(scope, message).length > 0,
    owns: (scope: ConnectionScope, message: IncomingMessage) =>
      matches(scope, message).some(({ actor }) => actor === message.userId),
    defer(scope: ConnectionScope, message: IncomingMessage, apply: () => Promise<void>) {
      const pending = matches(scope, message).filter(({ actor }) => actor === message.userId);
      if (!pending.length) return;
      const work = Promise.all(pending.map(({ actions }) => actions)).then(apply);
      const settled = work.catch(() => {});
      for (const prompt of pending) prompt.actions = settled;
      return work;
    },
  };
}
