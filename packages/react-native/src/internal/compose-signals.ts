/**
 * Compose a caller's `AbortSignal` with an internally-owned one (a timeout) into a single signal
 * that aborts when **either** does.
 *
 * Extracted as a pure primitive rather than inlined into `createRnHttpClient` for one reason: a
 * listener-leak claim is unobservable from a test that never holds the signal. Here the caller can
 * drive a thousand requests over one long-lived signal and assert the listener count returns to
 * zero. An RN session lives for hours; a leak on a session-lived signal is unbounded.
 *
 * Hand-rolled rather than `AbortSignal.any()`: Hermes (React Native's default engine) implements a
 * subset of the modern web platform, and this package already avoids assuming globals exist.
 */

export interface ComposedSignal {
  /** Aborts when the caller's signal aborts, or when the internal one does. */
  readonly signal: AbortSignal;
  /** Detach every listener this composition attached. Idempotent. */
  dispose(): void;
}

/**
 * Compose `caller` (optional) with `internal` (always present — the timeout).
 *
 * When there is no caller signal the internal one is returned as-is, so the common path allocates
 * no controller and attaches no listener.
 */
export function composeSignals(
  caller: AbortSignal | undefined,
  internal: AbortSignal,
): ComposedSignal {
  if (caller === undefined) {
    return { signal: internal, dispose: () => undefined };
  }

  const controller = new AbortController();
  const abort = (reason: unknown): void => {
    if (!controller.signal.aborted) controller.abort(reason);
  };

  const onCaller = (): void => abort(caller.reason);
  const onInternal = (): void => abort(internal.reason);

  if (caller.aborted) {
    abort(caller.reason);
  } else if (internal.aborted) {
    abort(internal.reason);
  } else {
    caller.addEventListener('abort', onCaller, { once: true });
    internal.addEventListener('abort', onInternal, { once: true });
  }

  let disposed = false;
  return {
    signal: controller.signal,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      caller.removeEventListener('abort', onCaller);
      internal.removeEventListener('abort', onInternal);
    },
  };
}
