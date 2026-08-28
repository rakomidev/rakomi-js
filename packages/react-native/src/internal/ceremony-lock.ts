/**
 * A provider-scoped mutual-exclusion handle for the passkey ceremony.
 *
 * Why the lock cannot live inside the hook: the passkey sheet is an **OS-global modal**. Two
 * components each calling `usePasskeys()` — a sign-in button in a header and a passkey-management
 * screen, say — hold two independent hook instances, and a per-hook lock would let both open a
 * ceremony. On iOS the second `ASAuthorizationController` silently cancels the first; on Android the
 * second `CredentialManager` call fails. Either way the user experiences one continuous attempt and
 * is told they cancelled it. A ref inside the hook cannot see the other hook; a handle on the
 * provider can.
 *
 * It is deliberately NOT snapshot-keyed. The context value is rebuilt on every `REFRESH_SUCCESS`, and
 * a lock recreated there would be released — mid-ceremony — by a background token refresh, which is
 * exactly when a long ceremony is most likely to be open.
 *
 * Not exported from the package: it is an internal coupling between the provider and the hook, not a
 * surface an integrator should reach for.
 */
export interface CeremonyLock {
  /** `true` if this caller now holds the lock; `false` if someone else already does. */
  tryAcquire(): boolean;
  /** Idempotent — releasing an unheld lock is a no-op, so a double-`finally` cannot corrupt it. */
  release(): void;
  /** For diagnostics and tests. Never gate on this: check-then-acquire is a race. */
  readonly held: boolean;
}

export function createCeremonyLock(): CeremonyLock {
  let held = false;
  return {
    tryAcquire(): boolean {
      if (held) return false;
      held = true;
      return true;
    },
    release(): void {
      held = false;
    },
    get held(): boolean {
      return held;
    },
  };
}
