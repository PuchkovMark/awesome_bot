const conversationLocks = new Map<string, Promise<void>>();

export async function serializeGameConversation<T>(
  conversationId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = conversationLocks.get(conversationId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  conversationLocks.set(conversationId, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (conversationLocks.get(conversationId) === tail) conversationLocks.delete(conversationId);
  }
}
