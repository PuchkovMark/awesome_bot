export const contextInput={version:9,name:'context-input',sql:`
ALTER TABLE messages ADD COLUMN attachment_count INTEGER CHECK(attachment_count IS NULL OR attachment_count BETWEEN 0 AND 9007199254740991);
`} as const;
