import { llmFailure } from './errors';
import { llmUserAgent, normalizeResponse, opencodeGoEndpoint } from './opencode';
import { nonblank, positiveInteger, prepareRequest } from './validation';
import type { PreparedRequest } from './validation';
import type {
  LlmClient,
  LlmClientOptions,
  LlmConfig,
  LlmFailure,
  LlmRequest,
  LlmResult,
} from './types';

function httpFailure(status: number): LlmFailure {
  if (status === 401) return llmFailure('authentication');
  if (status === 403) return llmFailure('forbidden');
  if (status === 429) return llmFailure('rate_limit');
  if (status >= 500 && status <= 599) return llmFailure('server');
  return llmFailure('http');
}
/** Создание явно и синхронно; конфигурация не читается из окружения. */
export function createLlmClient(config: LlmConfig, options: LlmClientOptions = {}): LlmClient {
  let model: string, apiKey: string, timeoutMs: number, maxResponseBytes: number;
  let transport: NonNullable<LlmClientOptions['fetch']>;
  try {
    if (
      !config ||
      config.provider !== 'opencode' ||
      !nonblank(config.model) ||
      /[\r\n\0]/.test(config.model) ||
      typeof config.apiKey !== 'string' ||
      !/^[!-~]+$/.test(config.apiKey)
    )
      throw Error();
    model = config.model;
    apiKey = config.apiKey;
    timeoutMs = options.timeoutMs ?? 60_000;
    maxResponseBytes = options.maxResponseBytes ?? 1_048_576;
    // Node.js превращает больший timeout в 1 мс; не допускать неявной подмены.
    if (
      !positiveInteger(timeoutMs) ||
      timeoutMs > 2_147_483_647 ||
      !positiveInteger(maxResponseBytes)
    )
      throw Error();
    if (options.fetch !== undefined && typeof options.fetch !== 'function') throw Error();
    transport = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  } catch {
    throw new TypeError('Некорректная конфигурация клиента LLM.');
  }
  return Object.freeze({
    async complete(request: LlmRequest): Promise<LlmResult> {
      let prepared: PreparedRequest;
      try {
        prepared = prepareRequest(request, model);
      } catch {
        return llmFailure('invalid_request');
      }
      if (prepared.signal?.aborted) return llmFailure('cancelled');
      const controller = new AbortController();
      let stopped: LlmFailure | undefined;
      let finishStop: (value: LlmFailure) => void = () => {};
      const halted = new Promise<LlmFailure>((resolve) => {
        finishStop = resolve;
      });
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const stop = (failure: LlmFailure) => {
        if (stopped) return;
        stopped = failure;
        finishStop(failure);
        // Не передавать наружу reason от вызывающего компонента.
        controller.abort();
      };
      const onAbort = () => stop(llmFailure('cancelled'));
      prepared.signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => stop(llmFailure('timeout')), timeoutMs);
      try {
        if (prepared.signal?.aborted) onAbort();
        if (stopped) return stopped;
        const operation = (async (): Promise<LlmResult> => {
          try {
            const response = await transport(opencodeGoEndpoint, {
              method: 'POST',
              redirect: 'error',
              signal: controller.signal,
              headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'User-Agent': llmUserAgent,
                'x-opencode-session': prepared.sessionId,
              },
              body: prepared.body,
            });
            if (stopped || response.redirected || response.status !== 200) {
              // При позднем ответе или HTTP-отказе тело не накапливается.
              try {
                void response.body?.cancel().catch(() => {});
              } catch {
                /* Без raw-ошибки. */
              }
              return stopped ?? httpFailure(response.status);
            }
            if (!response.body) return llmFailure('invalid_response');
            reader = response.body.getReader();
            const chunks: Uint8Array[] = [];
            let size = 0;
            for (;;) {
              const next = await reader.read();
              if (stopped) return stopped;
              if (next.done) break;
              size += next.value.byteLength;
              if (size > maxResponseBytes) return llmFailure('response_too_large');
              chunks.push(next.value);
            }
            const bytes = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) {
              bytes.set(chunk, offset);
              offset += chunk.byteLength;
            }
            try {
              const value: unknown = JSON.parse(
                new TextDecoder('utf-8', { fatal: true }).decode(bytes),
              );
              return normalizeResponse(value);
            } catch {
              return llmFailure('invalid_response');
            }
          } catch {
            return stopped ?? llmFailure('network');
          }
        })();
        return await Promise.race([operation, halted]);
      } finally {
        clearTimeout(timer);
        prepared.signal?.removeEventListener('abort', onAbort);
        try {
          void reader?.cancel().catch(() => {});
        } catch {
          /* Отмена не задерживает завершение. */
        }
        try {
          reader?.releaseLock();
        } catch {
          /* Незавершённое чтение может удерживать lock до отмены. */
        }
      }
    },
  });
}
