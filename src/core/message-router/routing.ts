import type { IncomingMessage } from '../../contracts/index';
import type { RoutingInput, RoutingDecision } from './types';
import { directlyAddressesName } from './name-address';
import { validIncoming } from './validation';
import { autonomousCause } from './autonomous-rules';
export function ordinaryGroupRoute(message: IncomingMessage, questionnaireName = false) {
  const address =
    message.replyAddress ??
    (message.isReplyToBot ? 'bot' : message.replyToMessageId !== undefined ? 'unknown' : undefined);
  if (address === 'unknown') return 'reply_unknown';
  if (address === 'other' && (!message.isMentioned || message.soleBotMention !== true))
    return 'reply_other';
  if (message.isMentioned) return 'mention';
  if (message.isReplyToBot) return 'reply';
  return questionnaireName || directlyAddressesName(message.text) ? 'name' : null;
}

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
    const action = service.command.action;
    const privatePreference = [
      'reminder.manage',
      'profile.self.address',
      'onboarding.self.manage',
      'persona.self.select',
    ].includes(action);
    const passport = action === 'chat.passport.read' || action === 'chat.passport.edit';
    const persona = action === 'chat.persona.read' || action === 'chat.persona.select';
    const participantCommand =
      service.command.minimumRole === 'member' &&
      (service.command.action === 'chat.pause' ||
        service.command.action === 'profile.self.manage' ||
        action === 'chat.passport.read' ||
        action === 'chat.persona.read' ||
        privatePreference);
    if (
      !service.allowed ||
      (service.command.journalLabel !== undefined && message.isBot !== false) ||
      (privatePreference &&
        (!settings.enabled || settings.responseMode === 'silent' || message.isBot !== false)) ||
      (passport &&
        (!settings.enabled || (settings.responseMode === 'silent' && service.role === 'member'))) ||
      (persona &&
        (!settings.enabled ||
          (action === 'chat.persona.read' &&
            settings.responseMode === 'silent' &&
            (!message.isGroupChat || service.role === 'member')))) ||
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
  const kind = message.isGroupChat
    ? ordinaryGroupRoute(message, input.questionnaireName)
    : 'direct_message';
  if (kind === 'reply_unknown' || kind === 'reply_other') return silent(kind);
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
