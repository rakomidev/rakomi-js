'use client';

import React, { useContext, useRef, useState } from 'react';

import { RakomiInternalsContext } from '../../context.js';
import { useAuth } from '../../hooks/use-auth.js';
import { AuthErrorBoundary } from '../../internal/auth-error-boundary.js';
import { sdkFetch } from '../../lib/fetch-client.js';
import type { CustomerPortalProps } from './types.js';

function CustomerPortalInner(props: CustomerPortalProps): React.ReactElement {
  const { tenantSlug, children, returnUrl, className, style } = props;

  const internals = useContext(RakomiInternalsContext);
  const auth = useAuth();
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const getTokenRef = useRef(auth.getToken);
  getTokenRef.current = auth.getToken;

  const handleClick = async () => {
    if (!internals) return;

    const tokenResult = await getTokenRef.current();
    if (!tokenResult.ok) {
      return;
    }

    const url = returnUrl ?? (typeof window !== 'undefined' ? window.location.href : '');

    setIsLoading(true);
    setErrorMsg(null);
    try {
      const resp = await sdkFetch(
        `${internals.baseUrl}/v1/billing/baas/${tenantSlug}/user/portal`,
        {
          method: 'POST',
          headers: {
            'X-API-Key': internals.clientId,
            'Authorization': `Bearer ${tokenResult.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ return_url: url }),
        },
      );

      if (!resp.ok) {
        const data = (await resp.json().catch(() => ({}))) as { error?: string };
        if (data.error === 'STRIPE_ACCOUNT_INACTIVE' || resp.status === 503) {
          setErrorMsg('Payment provider unavailable');
        } else {
          setErrorMsg('Failed to open billing portal');
        }
        return;
      }

      const data = (await resp.json()) as { url: string };
      window.location.href = data.url;
    } catch {
      setErrorMsg('Failed to open billing portal');
    } finally {
      setIsLoading(false);
    }
  };

  const isSignedIn = auth.isLoaded && auth.isSignedIn;

  return (
    <div
      data-rakomi-customer-portal
      className={className}
      style={style}
      aria-busy={isLoading || undefined}
    >
      {children ? (
        <span
          role="button"
          tabIndex={isSignedIn ? 0 : -1}
          aria-disabled={!isSignedIn || undefined}
          onClick={isSignedIn ? handleClick : undefined}
          onKeyDown={(e) => { if (isSignedIn && (e.key === 'Enter' || e.key === ' ')) void handleClick(); }}
        >
          {children}
        </span>
      ) : (
        <button
          type="button"
          aria-busy={isLoading || undefined}
          aria-disabled={!isSignedIn || undefined}
          disabled={isLoading}
          onClick={isSignedIn ? handleClick : undefined}
        >
          Manage Subscription
        </button>
      )}
      {errorMsg && <p data-rakomi-portal-error role="alert">{errorMsg}</p>}
    </div>
  );
}

export function CustomerPortal(props: CustomerPortalProps): React.ReactElement {
  return (
    <AuthErrorBoundary>
      <CustomerPortalInner {...props} />
    </AuthErrorBoundary>
  );
}
