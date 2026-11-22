import type { ChatId, ConnectionScope, UserId } from '../../contracts/index.js';
import { adminRecoveryStore, type RecoveryOperation } from '../../storage/admin-recovery-store.js';
import type { Storage } from '../../storage/index.js';
import type { createAuthorizationService } from '../authorization/service.js';
import type { createLifecycleService } from '../lifecycle/service.js';
import type { AdminRecoveryCommand } from './commands.js';

type OperationGuard = {readonly signal:AbortSignal;readonly isCurrent:()=>boolean};
interface OwnerDelivery {
  reply(text: string, guard: OperationGuard): Promise<void>;
  publish(text: string, sendId: number, receivedId: (messageId: string) => void,
    guard: OperationGuard): Promise<'delivered'|'failed'|'unknown'>;
  confirm(text: string, receipt: string, since: number, guard: OperationGuard): Promise<boolean>;
}

export function createAdminRecoveryService(options: {
  readonly storage: Storage;
  readonly authorization: Awaited<ReturnType<typeof createAuthorizationService>>;
  readonly lifecycle: ReturnType<typeof createLifecycleService>;
  readonly ownerId: UserId;
  readonly platform: string;
  readonly group: (chatId: ChatId) => boolean;
  readonly signal: AbortSignal;
  readonly delivery: OwnerDelivery;
  readonly hasMember: (scope: ConnectionScope, userId: UserId, guard: OperationGuard) => Promise<boolean>;
}) {
  const {ownerId,lifecycle,authorization,delivery,signal}=options;
  const store=adminRecoveryStore(options.storage);

  async function deliver(scope: ConnectionScope, row: RecoveryOperation, guard: OperationGuard, retryCommandId?: number) {
    if (!guard.isCurrent()) return;
    const claim=store.claim(scope,ownerId,row.id,Date.now(),retryCommandId);
    if (!claim) return;
    const verb=claim.result==='granted' ? 'назначен администратором бота' : 'уже имел явное назначение';
    const text=`Операция ${claim.id}. Участник ${claim.userId} ${verb} в беседе ${claim.chatId}@${claim.generation}.`;
    let outcome: 'delivered'|'failed'|'unknown';
    try {
      const confirmed=retryCommandId!==undefined && claim.receipt!==null && claim.attemptedAt!==null &&
        await delivery.confirm(text,claim.receipt,claim.attemptedAt,guard);
      outcome=confirmed ? 'delivered' : await delivery.publish(text,claim.sendId,
        receipt=>{if (guard.isCurrent()) store.recordReceipt(scope,claim,receipt);},guard);
    } catch { outcome='unknown'; }
    if (lifecycle.isAdmissionCurrent(scope)) {
      store.finish(scope,claim,outcome==='delivered' ? null : outcome==='failed' ? 'unavailable' : 'unconfirmed');
    }
  }

  function groupScope(chatId: ChatId, generation: number, pinned: boolean) {
    if (!options.group(chatId)) return undefined;
    try {
      const scope=pinned ? lifecycle.admissionScope(chatId) : lifecycle.current(chatId);
      return scope.generation===generation ? scope : undefined;
    } catch { return undefined; }
  }

  return {
    async handle(sender: UserId, command: AdminRecoveryCommand, commandId: number, current: () => boolean) {
      const guard={signal,isCurrent:()=>!signal.aborted&&current()};
      if (sender!==ownerId || !guard.isCurrent()) return;
      if (command.kind==='invalid') {
        await delivery.reply('Проверь формат служебной команды.',guard);
        return;
      }
      if (command.kind==='list') {
        const rows=store.list(options.platform,options.group);
        const missing=rows.filter(row=>row.state==='missing').map(row=>`${row.chatId}@${row.generation}`);
        const unknown=rows.filter(row=>row.state==='unknown').map(row=>`${row.chatId}@${row.generation}`);
        const lines=[missing.length ? ['Беседы без доступных администраторов бота',...missing].join('\n')
          : 'Бесед с подтверждённым отсутствием администраторов бота нет.'];
        if (unknown.length) lines.push(['Присутствие администраторов не подтверждено',...unknown].join('\n'));
        await delivery.reply(lines.join('\n\n'),guard);
        return;
      }
      if (command.kind==='retry') {
        const row=store.operation(ownerId,command.id);
        const scope=row && groupScope(row.chatId,row.generation,false);
        if (!scope || !row) {
          await delivery.reply('Действующая операция с таким номером не найдена.',guard);
          return;
        }
        if (row.state==='delivered') {
          await delivery.reply(`Доставка по операции ${row.id} уже подтверждена.`,guard);
          return;
        }
        await deliver(scope,row,{signal,isCurrent:()=>guard.isCurrent()&&lifecycle.isAdmissionCurrent(scope)},commandId);
        return;
      }
      const observed=groupScope(command.chatId,command.generation,true);
      const scope=groupScope(command.chatId,command.generation,false);
      if (!observed || !scope) {
        await delivery.reply('Беседа или поколение недоступны. Проверь список и состояние подключения.',guard);
        return;
      }
      if (store.command(ownerId,commandId)) return;
      const checking={signal,isCurrent:()=>guard.isCurrent()&&lifecycle.isAdmissionCurrent(observed)};
      if (!await options.hasMember(observed,command.userId,checking) || !checking.isCurrent()) {
        await delivery.reply('Не удалось подтвердить участие человека в указанной беседе.',guard);
        return;
      }
      const membership=await authorization.confirmMembership(observed,command.userId);
      const context=authorization.context({kind:'owner',scope,userId:sender});
      const result=await authorization.recoverAdmin(context,command.userId,commandId,membership,checking.isCurrent);
      if (!result.allowed) {
        await delivery.reply(result.code==='revoked' ? 'Для участника действует отзыв владельца.'
          : 'Назначение отклонено. Проверь состояние подключения и повтори команду.',guard);
        return;
      }
      if (result.value.created) await deliver(scope,result.value.operation,
        {signal,isCurrent:()=>guard.isCurrent()&&lifecycle.isAdmissionCurrent(scope)});
    },
  };
}
