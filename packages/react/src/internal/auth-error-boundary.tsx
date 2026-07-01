'use client';

/**
 * React Error Boundary for pre-built components.
 * Prevents SDK render errors from crashing the customer's application.
 * Shows "Something went wrong. [Retry]" with data-rakomi-error-boundary attribute.
 *
 * After 2 consecutive identical errors, retry is removed (permanent fallback with reload).
 * Fallback has role="alert" and receives programmatic focus.
 *
 * Wraps the class-based error boundary with a functional component that
 * reads onAuthEvent from RakomiInternalsContext, so error events are always emitted.
 */

import React, { useContext } from 'react';

import { RakomiInternalsContext } from '../context.js';
import type { AuthEvent } from '../types.js';

interface BoundaryProps {
  children: React.ReactNode;
  onAuthEvent?: (event: Partial<AuthEvent>) => void;
  fallbackMessage?: string;
  retryLabel?: string;
  permanentErrorMessage?: string;
  reloadLabel?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
  permanent: boolean;
}

class AuthErrorBoundaryClass extends React.Component<BoundaryProps, State> {
  state: State = { hasError: false, error: null, permanent: false };

  private retryCount = 0;
  private lastErrorMessage = '';
  private catchGuard = false;
  private focusApplied = false;

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return {
      hasError: true,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }

  componentDidUpdate(_prevProps: BoundaryProps, prevState: State): void {
    if (prevState.hasError && !this.state.hasError) {
      this.retryCount = 0;
      this.lastErrorMessage = '';
    }
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    if (this.catchGuard) return;
    this.catchGuard = true;
    queueMicrotask(() => { this.catchGuard = false; });

    const message = error instanceof Error ? error.message : String(error);
    if (this.lastErrorMessage === message) {
      this.retryCount++;
    } else {
      this.retryCount = 0;
      this.lastErrorMessage = message;
    }

    const safeMessage = message.slice(0, 256).replace(/https?:\/\/\S+/g, '[url]').replace(/eyJ[A-Za-z0-9_-]{10,}/g, '[token]');
    try {
      this.props.onAuthEvent?.({
        type: 'component_error',
        severity: 'warning',
        metadata: {
          error: safeMessage,
          componentStack: info.componentStack ?? '',
          retryCount: this.retryCount,
        },
      });
    } catch { }

    if (this.retryCount >= 2 && !this.state.permanent) {
      this.setState({ permanent: true });
    }
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      const isPermanent = this.state.permanent;

      return (
        <div data-rakomi-error-boundary role="alert">
          <p
            tabIndex={-1}
            ref={(el) => { if (el && !this.focusApplied) { this.focusApplied = true; el.focus(); } }}
          >
            {isPermanent
              ? (this.props.permanentErrorMessage ?? 'This component cannot recover. Please reload the page.')
              : (this.props.fallbackMessage ?? 'Something went wrong.')}
          </p>
          {isPermanent ? (
            <button
              type="button"
              onClick={() => window.location.reload()}
            >
              {this.props.reloadLabel ?? 'Reload page'}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => { this.focusApplied = false; this.setState({ hasError: false, error: null, permanent: false }); }}
            >
              {this.props.retryLabel ?? 'Retry'}
            </button>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}

/**
 * Functional wrapper that auto-connects to RakomiInternalsContext.
 * Components don't need to pass onAuthEvent manually — it's read from context.
 */
export function AuthErrorBoundary(props: { children: React.ReactNode; fallbackMessage?: string; retryLabel?: string; permanentErrorMessage?: string; reloadLabel?: string }): React.ReactElement {
  const internals = useContext(RakomiInternalsContext);
  const handleAuthEvent = internals ? (event: Partial<AuthEvent>) => {
    internals.emitEvent(event as Omit<AuthEvent, 'timestamp' | 'tabId'>);
  } : undefined;

  return (
    <AuthErrorBoundaryClass onAuthEvent={handleAuthEvent} fallbackMessage={props.fallbackMessage} retryLabel={props.retryLabel} permanentErrorMessage={props.permanentErrorMessage} reloadLabel={props.reloadLabel}>
      {props.children}
    </AuthErrorBoundaryClass>
  );
}
