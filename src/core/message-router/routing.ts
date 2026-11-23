import type { RoutingInput, RoutingDecision } from './types';
import { directlyAddressesName } from './name-address';
import { validIncoming } from './validation';
import { autonomousCause } from './autonomous-rules';
export function routeMessage(input: RoutingInput): RoutingDecision {
  if (!input || typeof input !== 'object') return { kind: 'silence', reason: 'invalid_input' };
  const { message, settings, service } = input;
  const silent = (
    reason: Extract<RoutingDecision, { kind: 'silence' }>['reason'],
  ): Extract<RoutingDecision, { kind: 'silence' }> => ({ kind: 'silence', reason });
  if (
    !validIncoming(message) ||
    !settings ||
    !['silent', 'normal', 'active'].includes(settings.responseMode) ||
    typeof settings.enabled !== 'boolean'
  )
    return silent('invalid_input');
  if (service) {
    const privatePreference = ['reminder.manage', 'profile.self.address'].includes(
      service.command.action,
    );
    const participantCommand =
      service.command.minimumRole === 'member' &&
      (service.command.action === 'chat.pause' ||
        service.command.action === 'profile.self.manage' ||
        privatePreference);
    if (
      !service.allowed ||
      (privatePreference &&
        (!settings.enabled || settings.responseMode === 'silent' || message.isBot !== false)) ||
      (service.role === 'member' && !participantCommand) ||
      (service.command.minimumRole === 'owner' && service.role !== 'owner') ||
      (!settings.enabled && service.role !== 'owner')
    )
      return silent('forbidden');
    return { kind: 'service', reason: 'service' };
  }
  if (!settings.enabled) return silent('disabled');
  if (message.isBot === 'unknown') return silent('sender_unknown');
  if (message.isBot) return silent('sender_bot');
  if (settings.responseMode === 'silent') return silent('silent');
  if (message.isGroupChat) {
    const address =
      message.replyAddress ??
      (message.isReplyToBot
        ? 'bot'
        : message.replyToMessageId !== undefined
          ? 'unknown'
          : undefined);
    if (address === 'unknown') return silent('reply_unknown');
    if (address === 'other' && (!message.isMentioned || message.soleBotMention !== true))
      return silent('reply_other');
  }
  const kind = !message.isGroupChat
    ? 'direct_message'
    : message.isMentioned
      ? 'mention'
      : message.isReplyToBot
        ? 'reply'
        : directlyAddressesName(message.text)
          ? 'name'
          : null;
  if (!kind) {
    const initiative =
      input.considerInitiative && settings.responseMode === 'active'
        ? autonomousCause(message)
        : undefined;
    return initiative ? { ...silent('not_addressed'), initiative } : silent('not_addressed');
  }
  const mode = !message.isGroupChat ? 'normal' : settings.responseMode;
  return {
    kind: 'ordinary',
    reason: kind,
    route: { kind, mode, isGroupChat: message.isGroupChat },
  };
}
