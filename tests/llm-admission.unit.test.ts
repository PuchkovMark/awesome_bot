import { expect, test, vi } from 'vitest';
import { createLlmAdmission } from '../src/core/llm-admission';
import type { LlmResult } from '../src/llm/types';

const result = { kind: 'complete', text: 'Тест', usage: { input: 3, output: 4 } } as const;

function fixture() {
  let time = 0;
  const gate = createLlmAdmission(undefined, () => time);
  const lifetime = { signal: new AbortController().signal, current: () => true };
  const hold = () => Promise.withResolvers<LlmResult>();
  async function occupy(count: number) {
    const held = Array.from({ length: count }, hold);
    const calls = await Promise.all(
      held.map((entry) => gate.direct(lifetime, (send) => send(() => entry.promise))),
    );
    return {
      release(index: number) {
        held[index]!.resolve(result);
      },
      async close() {
        for (const entry of held) entry.resolve(result);
        await Promise.all(calls.map((call) => call.kind === 'ready' && call.value));
      },
    };
  }
  return {
    gate,
    lifetime,
    hold,
    occupy,
    at: (value: number) => {
      time = value;
    },
  };
}

test('место занято только с отправки, а отказ в резерве оставляет его свободным', async () => {
  const f = fixture();
  const first = await f.occupy(3);
  const trial = await f.gate.direct(f.lifetime, () => {
    expect(f.gate.stats().active).toBe(3);
    return 'quota_exhausted';
  });
  expect(trial).toEqual({ kind: 'ready', value: 'quota_exhausted' });
  const held = f.hold();
  const fourth = await f.gate.direct(f.lifetime, (send) => {
    expect(f.gate.stats().active).toBe(3);
    return send(() => {
      expect(f.gate.stats().active).toBe(4);
      return held.promise;
    });
  });
  const request = vi.fn(async () => result);
  const fifth = f.gate.direct(f.lifetime, (send) => send(request));
  expect(request).not.toHaveBeenCalled();
  expect(f.gate.background(f.lifetime, (send) => send(request))).toEqual({
    kind: 'background_busy',
  });
  f.at(9_999);
  held.resolve(result);
  const accepted = await fifth;
  expect(accepted.kind).toBe('ready');
  expect(request).toHaveBeenCalledOnce();
  await first.close();
  if (fourth.kind === 'ready') await fourth.value;
  if (accepted.kind === 'ready') await accepted.value;
  expect(f.gate.stats()).toEqual({ active: 0, background: 0, waiting: 0 });
});

test.each(['граница ожидания', 'более короткий срок', 'отмена', 'потеря источника'] as const)(
  'в ожидании %s освобождает запрос без отправки и допуска',
  async (mode) => {
    const f = fixture();
    const slots = await f.occupy(4);
    const controller = new AbortController();
    let current = true;
    const prepare = vi.fn();
    const admission = f.gate.direct(
      {
        signal: controller.signal,
        current: () => current,
        ...(mode === 'более короткий срок' ? { deadline: 600 } : {}),
      },
      prepare,
    );
    f.at(mode === 'более короткий срок' ? 600 : mode === 'граница ожидания' ? 10_000 : 500);
    if (mode === 'отмена') controller.abort();
    if (mode === 'потеря источника') current = false;
    slots.release(0);
    expect(await admission).toEqual({
      kind: current && !controller.signal.aborted ? 'llm_wait_timeout' : 'cancelled',
    });
    expect(prepare).not.toHaveBeenCalled();
    await slots.close();
  },
);

test('истечение таймера снимает ожидание, пока все места по-прежнему заняты', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const slots = await f.occupy(4);
  try {
    const prepare = vi.fn();
    const waiting = f.gate.direct(f.lifetime, prepare);
    f.at(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await waiting).toEqual({ kind: 'llm_wait_timeout' });
    expect(prepare).not.toHaveBeenCalled();
    expect(f.gate.stats()).toEqual({ active: 4, background: 0, waiting: 0 });
  } finally {
    await slots.close();
    vi.useRealTimers();
  }
});

test('фоновый предел общий, следующее место получает ожидающий прямой вызов', async () => {
  const f = fixture();
  const first = await f.occupy(3);
  const held = f.hold();
  const started = f.gate.background(f.lifetime, (send) => send(() => held.promise));
  const order: string[] = [];
  const third = f.gate.direct(f.lifetime, (send) =>
    send(async () => {
      order.push('прямой');
      expect(f.gate.background(f.lifetime, (later) => later(async () => result))).toEqual({
        kind: 'background_busy',
      });
      return result;
    }),
  );
  expect(f.gate.stats()).toEqual({ active: 4, background: 1, waiting: 1 });
  held.resolve(result);
  if (started.kind === 'ready') await started.value;
  const direct = await third;
  if (direct.kind === 'ready') await direct.value;
  expect(
    f.gate.background(f.lifetime, (send) =>
      send(async () => {
        order.push('фоновый');
        return result;
      }),
    ).kind,
  ).toBe('ready');
  await first.close();
  expect(order).toEqual(['прямой', 'фоновый']);
});
