export const contextOrderIndex={version:10,name:'context-order-index',sql:`
CREATE INDEX messages_context_order ON messages(chat_id,id DESC) WHERE purpose='conversation';
`} as const;
