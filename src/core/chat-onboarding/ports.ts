import type { ConnectionScope } from '../../contracts/index.js';

export interface IntroductionGuard {
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
  readonly allow?: () => boolean | Promise<boolean>;
}

export type WritePermission = 'allowed' | 'denied' | 'unknown';
export type ServiceDelivery = { readonly kind: 'delivered'; readonly receipt: string }
  | { readonly kind: 'failed' | 'unknown' };

export interface IntroductionPort {
  writing(scope: ConnectionScope, target: 'chat' | 'owner', guard: IntroductionGuard): Promise<WritePermission>;
  hasAdministration(scope: ConnectionScope, guard: IntroductionGuard): Promise<boolean>;
  publish(scope: ConnectionScope, target: 'chat' | 'owner', text: string, sendId: number, guard: IntroductionGuard,
    replayUntil?: number): Promise<ServiceDelivery>;
  confirm(scope: ConnectionScope, text: string, receipt: string, notBefore: number, guard: IntroductionGuard): Promise<boolean>;
}
