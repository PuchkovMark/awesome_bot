export type FactSourceKind = 'self' | 'inferred' | 'admin';

export type FactReliability = 'unknown' | 'unverified' | 'confirmed';

export interface PublicProfileFact {
  readonly fieldKey: string;
  readonly value: string;
  readonly sourceKind: FactSourceKind;
  readonly reliability: FactReliability;
}

declare const contextCardFactReference: unique symbol;
export interface ContextCardFactReference {
  readonly [contextCardFactReference]: true;
}
export interface ContextCardFact {
  readonly value: PublicProfileFact;
  readonly reference: ContextCardFactReference;
  readonly sourceIds: readonly number[];
}
