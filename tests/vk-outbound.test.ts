import { describe, expect, it, vi } from 'vitest';
import type { PublishedPart } from '../src/contracts/index.js';
import { VkApiError } from '../src/channels/vk/api.js';
import type { VkApiCall } from '../src/channels/vk/api.js';
import { createVkOutbound } from '../src/channels/vk/outbound.js';
import { splitVkText, vkMessageLength } from '../src/channels/vk/outbound-text.js';
import { VkRequestCancelled } from '../src/channels/vk/rate-limit.js';

const groupId = 314;
const sourceId = '7';
const date = 1_700_000_000;

function fixture(peer: number, settings: {
  readonly beforeSend?: (attempt: number) => unknown;
  readonly transform?: (row: Record<string, unknown>) => Record<string, unknown>;
} = {}) {
  const source = { peer_id: peer, conversation_message_id: 7, from_id: 161, date, text: 'Вопрос' };
  const rows = new Map<number, Record<string, unknown>>([[7, source]]);
  const keep = vi.fn<(part: PublishedPart) => void>();
  let attempts = 0;
  const request = vi.fn<VkApiCall>(async (method, parameters, guard) => {
    if (guard?.signal?.aborted) throw new VkRequestCancelled();
    switch (method) {
      case 'messages.getByConversationMessageId':
        return { items: [rows.get(Number(parameters.conversation_message_ids))].filter(Boolean) };
      case 'messages.setActivity':
        return 1;
      case 'messages.send': {
        attempts++;
        const response = settings.beforeSend?.(attempts);
        if (response !== undefined) return response;
        const cmid = 7 + rows.size;
        const row = {
          peer_id: peer, conversation_message_id: cmid, from_id: -groupId, date: date + cmid, text: parameters.message,
          ...(parameters.forward ? { reply_message: source } : {}),
        };
        rows.set(cmid, settings.transform?.(row) ?? row);
        return [{ peer_id: peer, message_id: 0, conversation_message_id: cmid }];
      }
      default:
        throw new Error('Unexpected test method');
    }
  });
  const outbound = createVkOutbound({ groupId, api: { request }, wait: async () => undefined });
  const sent = () => request.mock.calls.filter(([method]) => method === 'messages.send');
  return { outbound, request, sent, keep, chatId: `vk:${peer}` as const };
}

describe('разбиение текста VK', () => {
  it('применяет проверенный предел в байтах и сохраняет Unicode', () => {
    const family = '🧑‍🔬';
    const text = 'a'.repeat(3998) + family + 'я'.repeat(2500) + '!';
    const parts = splitVkText(text);
    expect(vkMessageLength).toEqual({ value: 4000, unit: 'utf8Bytes' });
    expect(parts.join('')).toBe(text);
    expect(parts[0]).toBe('a'.repeat(3998));
    expect(parts[1]?.startsWith(family)).toBe(true);
    expect(parts.every(part => Buffer.byteLength(part) <= 4000 && part.isWellFormed())).toBe(true);
    expect(splitVkText('ж'.repeat(2000))).toHaveLength(1);
  });

  it('предпочитает абзац и умеет разделить исключительно длинный кластер Unicode', () => {
    const paragraph = 'a'.repeat(1100) + '\n\n';
    expect(splitVkText(paragraph + 'n'.repeat(3500))[0]).toBe(paragraph);
    const unusual = 'e' + '\u0301'.repeat(3000);
    const split = splitVkText(unusual);
    expect(split.join('')).toBe(unusual);
    expect(split.every(part => Buffer.byteLength(part) <= 4000)).toBe(true);
    expect(splitVkText('   ')).toEqual([]);
  });
});

describe('отправитель VK', () => {
  it.each([161, 2_000_000_004])('подтверждает части в пределах peer %s с reply только у первой', async (peer) => {
    const f = fixture(peer);
    const text = '🙂'.repeat(1100);
    const result = await f.outbound.send({ chatId: f.chatId, kind: 'answer', text, replyToMessageId: sourceId, confirmPart: f.keep });
    expect(result).toEqual({ kind: 'delivered', confirmedParts: 2 });
    expect(f.sent().map(([, p]) => p.peer_ids)).toEqual([String(peer), String(peer)]);
    const [first, second] = f.sent().map(([, p]) => p);
    expect(JSON.parse(String(first?.forward))).toEqual({ peer_id: peer, conversation_message_ids: [7], is_reply: true });
    expect(second?.forward).toBeUndefined();
    expect(first?.random_id).not.toBe(second?.random_id);
    expect(f.keep.mock.calls.map(([part]) => part.text).join('')).toBe(text);
    expect(f.keep.mock.calls[0]?.[0]).toMatchObject({ messageId: '8', userId: 'vk:-314', timestamp: (date + 8) * 1000, replyToMessageId: '7' });
    expect(f.keep.mock.calls[1]?.[0]).not.toHaveProperty('replyToMessageId');
  });

  it('повторяет только окончательно отклонённый по частоте запрос с прежним random_id', async () => {
    const f = fixture(161, { beforeSend: i => i === 1 ? [{ peer_id: 161, error: { error_code: 6 } }] : undefined });
    const result = await f.outbound.send({ chatId: f.chatId, kind: 'answer', text: 'Тест', confirmPart: f.keep });
    expect(result).toEqual({ kind: 'delivered', confirmedParts: 1 });
    expect(f.sent()).toHaveLength(2);
    expect(f.sent()[0]?.[1]).toEqual(f.sent()[1]?.[1]);
    expect(f.keep).toHaveBeenCalledOnce();
  });

  it('не повторяет противоречивую квитанцию с локальным номером и кодом 6', async () => {
    const f = fixture(161, { beforeSend: () => [{ peer_id: 161, conversation_message_id: 8, error: { error_code: 6 } }] });
    expect(await f.outbound.send({ chatId: f.chatId, kind: 'answer', text: 'Тест', confirmPart: f.keep }))
      .toEqual({ kind: 'unknown', confirmedParts: 0 });
    expect(f.sent()).toHaveLength(1);
    expect(f.keep).not.toHaveBeenCalled();
  });

  it.each([[914, 'failed', 1], [6, 'failed', 3], [10, 'unknown', 1], [undefined, 'unknown', 1]] as const)(
    'различает отказ и неизвестный исход для кода %s', async (code, outcome, calls) => {
      const f = fixture(161, { beforeSend() { throw new VkApiError(code); } });
      expect(await f.outbound.send({ chatId: f.chatId, kind: 'answer', text: 'a'.repeat(4100), confirmPart: f.keep }))
        .toEqual({ kind: outcome, confirmedParts: 0 });
      expect(f.sent()).toHaveLength(calls);
      expect(f.keep).not.toHaveBeenCalled();
    },
  );

  it('журналирует фактическую часть после преобразования VK и останавливает остаток', async () => {
    const f = fixture(161, { transform: row => ({ ...row, text: 'Текст, оставшийся после обработки VK' }) });
    expect(await f.outbound.send({ chatId: f.chatId, kind: 'answer', text: 'a'.repeat(4100), confirmPart: f.keep }))
      .toEqual({ kind: 'unknown', confirmedParts: 1 });
    expect(f.sent()).toHaveLength(1);
    expect(f.keep).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: 'Текст, оставшийся после обработки VK' }));
  });

  it('отклоняет повтор локального ID у разных частей', async () => {
    const f = fixture(161, { beforeSend: index => index === 2 ? [{ peer_id: 161, conversation_message_id: 8 }] : undefined });
    expect(await f.outbound.send({ chatId: f.chatId, kind: 'answer', text: 'a'.repeat(8300), confirmPart: f.keep }))
      .toEqual({ kind: 'unknown', confirmedParts: 1 });
    expect(f.sent()).toHaveLength(2);
    expect(f.keep).toHaveBeenCalledOnce();
  });

  it.each([{ peer_id: 162 }, { from_id: -999 }, { date: undefined }])(
    'останавливается при непроверяемой записи %o', async override => {
      const f = fixture(161, { transform: row => ({ ...row, ...override }) });
      expect(await f.outbound.send({ chatId: f.chatId, kind: 'answer', text: 'Тест', confirmPart: f.keep }))
        .toEqual({ kind: 'unknown', confirmedParts: 0 });
      expect(f.sent()).toHaveLength(1);
      expect(f.keep).not.toHaveBeenCalled();
    },
  );

  it('использует только scoped reply для единичного уведомления и адресует typing отдельно', async () => {
    const f = fixture(2_000_000_004);
    expect(await f.outbound.canReply(f.chatId, sourceId, {})).toBe(true);
    expect(await f.outbound.canReply(f.chatId, '99', {})).toBe(false);
    await f.outbound.sendTyping(f.chatId, {});
    expect(f.request).toHaveBeenCalledWith('messages.setActivity', { peer_id: 2_000_000_004, type: 'typing', group_id: groupId }, {});
    expect(await f.outbound.send({ chatId: f.chatId, kind: 'notice', text: 'Сбой', confirmPart: f.keep }))
      .toEqual({ kind: 'failed', confirmedParts: 0 });
    expect(f.sent()).toHaveLength(0);
    expect(await f.outbound.send({ chatId: f.chatId, kind: 'notice', text: 'Сбой', replyToMessageId: sourceId, confirmPart: f.keep }))
      .toEqual({ kind: 'delivered', confirmedParts: 1 });
  });

  it('при отмене в обработчике подтверждения не начинает следующую часть', async () => {
    const f = fixture(161);
    const controller = new AbortController();
    const confirmPart = vi.fn(() => controller.abort());
    const result = await f.outbound.send({ chatId: f.chatId, kind: 'answer', text: 'a'.repeat(4100), signal: controller.signal, confirmPart });
    expect(result).toEqual({ kind: 'failed', confirmedParts: 1 });
    expect(confirmPart).toHaveBeenCalledOnce();
    expect(f.sent()).toHaveLength(1);
  });
});
