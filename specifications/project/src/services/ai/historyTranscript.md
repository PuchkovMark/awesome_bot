# historyTranscript

[`HISTORY_REQUEST_LIMIT`, `codePointLength`, `splitHistoryText`](../../../../../src/services/ai/historyTranscript.ts) задают границу 180000 Unicode code points и делят строку без потери её содержимого: по последнему абзацу в пределах окна, иначе по последнему предложению, иначе по границе code point. Недопустимый неположительный размер вызывает ошибку. Метаданные частей добавляет [DirectSubagentService](directSubagentService.md); ограничение относится к полному запросу с инструкциями. Прямых тестов модуля в `test/` нет.
