export const removeLegacyChatPrompt={version:11,name:'remove-legacy-chat-prompt',sql:`
ALTER TABLE chats DROP COLUMN system_prompt;
`} as const;
