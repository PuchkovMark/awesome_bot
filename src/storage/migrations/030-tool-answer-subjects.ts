export const toolAnswerSubjects = {
  version: 30, name: 'tool-answer-subjects',
  sql: `CREATE TABLE tool_answer_subjects(
    answer_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL, PRIMARY KEY(user_id,answer_id)
  ) STRICT;`,
} as const;
