import type {
  CapabilityContext,
  CapabilitySnapshot,
  ChannelAdapter,
  ChatId,
  EventHandler,
  IncomingEvent,
  OutgoingMessage,
  SendResult,
  UserId,
} from '../../src/contracts/index';

/** Подмена только для демонстрации контракта; не эмулирует права или сеть. */
export class FakeAdapter implements ChannelAdapter {
  readonly sent: OutgoingMessage[] = [];
  readonly typing: ChatId[] = [];
  readonly nameRequests: UserId[] = [];
  readonly capabilityRequests: CapabilityContext[] = [];
  readonly platform: 'test-a' | 'test-b';
  readonly events: readonly IncomingEvent[];

  constructor(platform: 'test-a' | 'test-b', events: readonly IncomingEvent[] = []) {
    this.platform = platform;
    this.events = events;
  }

  async capabilities(context: CapabilityContext): Promise<CapabilitySnapshot> {
    this.capabilityRequests.push(context);
    return {
      context,
      observedAt: 1_700_000_000_000,
      support: {
        send: 'supported',
        typing: this.platform === 'test-a' ? 'supported' : 'unsupported',
        reply: 'supported',
        getUserName: 'supported',
        adminInfo: 'unknown',
        membershipEvents: this.platform === 'test-a' ? 'supported' : 'unknown',
        directMessage: context.userId === `${this.platform}:known` ? 'supported' : 'unknown',
      },
      maxMessageLength:
        this.platform === 'test-a'
          ? { value: 100, unit: 'utf16' }
          : { value: 200, unit: 'utf8Bytes' },
      textFormats: this.platform === 'test-a' ? ['plain'] : ['plain', 'markdown'],
    };
  }

  async start(handler: EventHandler): Promise<void> {
    for (const event of this.events) await handler(event);
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    this.sent.push(message);
    return this.platform === 'test-a' ? ['part-1'] : ['part-1', 'part-2'];
  }

  async sendTyping(chatId: ChatId): Promise<void> {
    this.typing.push(chatId);
  }

  async getUserName(userId: UserId): Promise<string | null> {
    this.nameRequests.push(userId);
    return userId === `${this.platform}:known` ? `Имя ${this.platform}` : null;
  }
}
