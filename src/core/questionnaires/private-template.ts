import type { QuestionnaireTemplate } from '../../contracts/questionnaire';
import { questionnaireQuestions } from './legacy-template';

export const privateQuestionnaire: QuestionnaireTemplate = Object.freeze({
  key: 'private-introduction',
  revision: 1,
  questions: questionnaireQuestions([
    'Как к тебе обращаться?',
    'Из какого ты города?',
    'Чем увлекаешься?',
  ]),
});
