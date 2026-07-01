/**
 * EUDI Wallet (eIDAS) accessors.
 *
 * Offline, claim-derived helpers (NOT a live API call) for inspecting whether a
 * verified token was issued via an EU Digital Identity Wallet and at what eIDAS
 * level of assurance.
 */

import type { TokenPayload } from './types.js';

/** eIDAS levels of assurance (Reg. EU 910/2014 Art. 8), low < substantial < high. */
export type EidasLevel = 'low' | 'substantial' | 'high';

/**
 * True when the token represents an EU Digital Identity Wallet authentication —
 * either `acr` is one of the eIDAS levels (`eidas_low` / `eidas_substantial` /
 * `eidas_high` — the verifier emits the level it actually verified) OR `amr`
 * includes `'eudi_wallet'`. Derived from the already-verified payload; do NOT
 * trust an unverified token.
 */
export function isEudiVerified(payload: Pick<TokenPayload, 'acr' | 'amr'>): boolean {
  return (
    payload.acr === 'eidas_high' ||
    payload.acr === 'eidas_substantial' ||
    payload.acr === 'eidas_low' ||
    (payload.amr?.includes('eudi_wallet') ?? false)
  );
}

/**
 * The VERIFIED eIDAS level of assurance from the token's `assurance_level` claim,
 * or `undefined` when the token did not carry one (non-EUDI login).
 */
export function eidasLevel(payload: Pick<TokenPayload, 'assurance_level'>): EidasLevel | undefined {
  return payload.assurance_level;
}
