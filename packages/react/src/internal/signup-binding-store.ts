/**
 * Sign-up binding — the registering-browser bindings (`signup_binding`) `<SignUp />` keeps between the registration and the
 * verification link. `sessionStorage` only, never `localStorage` or a cookie — it lives
 * as long as the tab, and a link opened in another tab, browser or device verifies without it, so the server resets the
 * registration password (`credentials_reset`) by design. Every access is guarded: storage that is unavailable (SSR,
 * a privacy mode that throws) behaves like an empty store.
 *
 * one entry per publishable key (two Rakomi projects on one origin never read each other's), and a LIST
 * (newest last, at most SIGNUP_BINDINGS_MAX): a resend's answer cannot be told from a decoy (no link mailed — a rate
 * limit, say), so it is added, never put in place of the binding of a link that may still be the one clicked. Every
 * kept value goes with the verification and the next resend.
 */
/** The most bindings the API takes in one signup_binding list (verify-email, resend-verification). */
const SIGNUP_BINDINGS_MAX = 5;
const KEY_PREFIX = 'rakomi.signup_binding.';
const SHAPE = /^[0-9a-f]{64}$/;

function storage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}

/** The bindings this tab keeps for `publishableKey` (malformed values dropped). */
export function readSignupBindings(publishableKey: string): string[] {
  try {
    const value = storage()?.getItem(KEY_PREFIX + publishableKey) ?? '';
    return value.split('.').filter((b) => SHAPE.test(b)).slice(-SIGNUP_BINDINGS_MAX);
  } catch {
    return [];
  }
}

/** Adds the binding of a registration or resend answer (a malformed value is not kept). */
export function keepSignupBinding(publishableKey: string, binding: string | undefined): void {
  if (!binding || !SHAPE.test(binding)) return;
  const list = [...readSignupBindings(publishableKey).filter((b) => b !== binding), binding].slice(-SIGNUP_BINDINGS_MAX);
  try {
    storage()?.setItem(KEY_PREFIX + publishableKey, list.join('.'));
  } catch {
  }
}

/** Forgets the bindings once a verification has used them. */
export function forgetSignupBindings(publishableKey: string): void {
  try {
    storage()?.removeItem(KEY_PREFIX + publishableKey);
  } catch {
  }
}
