# summaryUtils

**Тип:** функции разбора параметров пересказа. **Источник:** [summaryUtils.ts](../../../../../src/services/command/summaryUtils.ts): `getSummaryHoursFromPayload`, `getSummaryHoursFromText`, `limitSentences`.

Допустимая длительность — тип `SummaryHours` со значением 2 или 6. Payload может быть JSON-строкой либо объектом с `command: 'summary'` и `hours: 2 | 6`; неправильный JSON и другие значения дают `null`. Текстовый разбор ищет отдельное число 2 или 6 с необязательным «за» и формой «ч». `limitSentences` использует `Intl.Segmenter('ru', { granularity: 'sentence' })` и возвращает первые `maximum` предложений. Функции не проверяют права и не обращаются к БД; отдельные тесты не обнаружены.
