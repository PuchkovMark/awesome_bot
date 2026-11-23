import type { ChatId } from './identifiers';

export interface QuestionnaireQuestion {
  readonly position: number;
  readonly text: string;
  readonly skippable: true;
}

export interface QuestionnaireTemplate {
  readonly key: string;
  readonly revision: number;
  readonly questions: readonly QuestionnaireQuestion[];
}

export interface QuestionnaireRevisionRef {
  readonly chatId: ChatId;
  readonly generation: number;
  readonly key: string;
  readonly revision: number;
}

export interface QuestionnaireRevision {
  readonly ref: QuestionnaireRevisionRef;
  readonly questions: readonly QuestionnaireQuestion[];
}
