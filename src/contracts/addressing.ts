import type { UserId } from './identifiers';

export interface AddressPreferenceReference {
  readonly userId: UserId;
  readonly revision: number;
  readonly sourceTime: number;
  readonly isGroupChat: boolean;
}

export interface AddressForm {
  readonly text: string;
  readonly reference: AddressPreferenceReference;
}
