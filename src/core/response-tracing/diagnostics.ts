import type { AuthorizationContext, ConnectionScope } from '../../contracts/index';
import type { Storage } from '../../storage/index';
import type { createAuthorizationService } from '../authorization/service';
import { traceBackend } from '../../storage/trace-store';
/** Только доверенная композиция: проверка личности и чтение выполняются в одной транзакции. */
export function createTraceDiagnostics(options: {
  readonly storage: Storage;
  readonly authorization: Pick<
    Awaited<ReturnType<typeof createAuthorizationService>>,
    'readDiagnostics'
  >;
}) {
  const backend = traceBackend(options.storage);
  return Object.freeze({
    get(context: AuthorizationContext, jobId: number) {
      return options.authorization.readDiagnostics(context, () =>
        backend.get(context.scope, jobId),
      );
    },
    last(context: AuthorizationContext) {
      return options.authorization.readDiagnostics(context, () => backend.get(context.scope));
    },
    explain(context: AuthorizationContext, id?: number) {
      return options.authorization.readDiagnostics(context, () => {
        const trace = backend.deliveredAnswer(context.scope, id);
        if (!trace) return null;
        const cause = trace.payload.route?.kind;
        const reason =
          cause === 'mention'
            ? 'упоминание бота'
            : cause === 'reply'
              ? 'ответ на сообщение бота'
              : cause === 'name'
                ? 'обращение по имени'
                : 'обращение';
        const mode = trace.payload.route?.mode;
        const lines = [`Повод ответа: ${reason}.`];
        if (mode === 'normal' || mode === 'active')
          lines.push(`Режим: ${mode === 'active' ? 'активный' : 'нормальный'}.`);
        const finished = new Date(trace.finishedAt!);
        if (Number.isFinite(finished.getTime()))
          lines.push(`Обработка завершилась ${finished.toISOString()}.`);
        const bytes = trace.payload.context?.layerBytes;
        const sources = [];
        if (bytes?.system) sources.push('системные правила');
        if (bytes?.environment) sources.push('настройки беседы');
        if (bytes?.messages) sources.push('сообщения беседы');
        if (sources.length) lines.push(`Источники: ${sources.join(', ')}.`);
        return { jobId: trace.jobId, text: lines.join('\n') };
      });
    },
  });
}
/** Порт инфраструктурной очистки, не команда участника и не инструмент модели. */
export function createTraceMaintenance(storage: Storage) {
  const backend = traceBackend(storage);
  return Object.freeze({
    prune(scope: ConnectionScope, now: number, limit = 100) {
      return backend.prune(scope, now, limit);
    },
  });
}
