/**
 * Sign-up binding — the registering-device bindings (`signup_binding`) between a registration and its verification link.
 * React Native has no `sessionStorage`, so the bindings live ONLY in this in-memory flow
 * state, keyed by publishable key — never in AsyncStorage, the keychain or any other persistent store. They end with the
 * app process: a link opened after a restart, or on another device, verifies without them and the server resets the
 * registration password (`credentialsReset`) by design.
 *
 * a LIST (newest last, at most SIGNUP_BINDINGS_MAX): a resend's answer cannot be told from a decoy, so
 * it is added, never put in place of the binding of a link that may still be the one opened.
 */
/** The most bindings the API takes in one signup_binding list (verify-email, resend-verification). */
const SIGNUP_BINDINGS_MAX = 5;
const bindings = new Map<string, string[]>();
const SHAPE = /^[0-9a-f]{64}$/;

export function keepSignupBinding(publishableKey: string, binding: string | undefined): void {
  if (!binding || !SHAPE.test(binding)) return;
  const kept = (bindings.get(publishableKey) ?? []).filter((b) => b !== binding);
  bindings.set(publishableKey, [...kept, binding].slice(-SIGNUP_BINDINGS_MAX));
}

export function readSignupBindings(publishableKey: string): string[] {
  return [...(bindings.get(publishableKey) ?? [])];
}

export function forgetSignupBindings(publishableKey: string): void {
  bindings.delete(publishableKey);
}
