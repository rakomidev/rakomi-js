'use client';

import React, { useEffect, useRef } from 'react';

import { resolveClassName, useGlobalAppearance } from '../../appearance.js';
import { useBaasSubscription } from '../../hooks/use-baas-subscription.js';
import { useBranding } from '../../hooks/use-branding.js';
import { AuthErrorBoundary } from '../../internal/auth-error-boundary.js';
import { applyBranding } from '../../internal/branding-styles.js';
import type { SubscriptionManagerProps } from './types.js';

const STATUS_COLORS: Record<string, string> = {
  active: '#16a34a',
  trialing: '#2563eb',
  past_due: '#ea580c',
  cancelled: '#6b7280',
};

function SubscriptionManagerInner(props: SubscriptionManagerProps): React.ReactElement {
  const {
    tenantSlug,
    className,
    style,
    locale,
    onSubscriptionChange,
    fallback,
  } = props;

  const { branding } = useBranding();
  const brandingStyle = applyBranding(branding);
  const globalAppearance = useGlobalAppearance();
  const cls = (element: string) => resolveClassName(element, props.appearance, globalAppearance);

  const { subscription, isLoading, error } = useBaasSubscription({ tenantSlug });

  const onSubscriptionChangeRef = useRef(onSubscriptionChange);
  onSubscriptionChangeRef.current = onSubscriptionChange;

  useEffect(() => {
    if (!onSubscriptionChange) return;

    const handleFocus = () => {
      onSubscriptionChangeRef.current?.();
    };

    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [!!onSubscriptionChange]);

  const formatDate = (iso: string | null): string => {
    if (!iso) return '';
    return new Intl.DateTimeFormat(locale ?? 'en', { dateStyle: 'medium' }).format(new Date(iso));
  };

  const getDaysRemaining = (iso: string | null): number => {
    if (!iso) return 0;
    const ms = new Date(iso).getTime() - Date.now();
    return Math.max(0, Math.ceil(ms / 86_400_000));
  };

  if (isLoading) {
    return (
      <div
        data-rakomi-subscription-manager
        style={{ ...brandingStyle, ...style }}
        className={cls('root') || className}
        aria-busy="true"
      >
        <div data-rakomi-skeleton style={{ height: '120px', background: '#f0f0f0', borderRadius: '8px' }} />
      </div>
    );
  }

  if (error === 'NOT_SIGNED_IN') {
    return (
      <div
        data-rakomi-subscription-manager
        style={{ ...brandingStyle, ...style }}
        className={cls('root') || className}
      >
        {fallback ?? <p>Please sign in to view your subscription.</p>}
      </div>
    );
  }

  if (!subscription) {
    return (
      <div
        data-rakomi-subscription-manager
        style={{ ...brandingStyle, ...style }}
        className={cls('root') || className}
      >
        {fallback ?? <p>No active subscription.</p>}
      </div>
    );
  }

  const statusColor = STATUS_COLORS[subscription.status] ?? '#6b7280';

  return (
    <div
      data-rakomi-subscription-manager
      style={{ ...brandingStyle, ...style }}
      className={cls('root') || className}
    >
      <p data-rakomi-plan-name>{subscription.plan_name}</p>
      <span
        role="status"
        aria-live="polite"
        data-rakomi-status={subscription.status}
        style={{ color: statusColor, fontWeight: 600 }}
      >
        {subscription.status}
      </span>

      {subscription.status === 'trialing' && subscription.trial_end && (
        <p data-rakomi-trial-end>
          Trial ends {formatDate(subscription.trial_end)} ({getDaysRemaining(subscription.trial_end)} days remaining)
        </p>
      )}

      {subscription.status === 'past_due' && (
        <p data-rakomi-past-due>
          Payment failed — update payment method
        </p>
      )}

      {subscription.status === 'cancelled' && (
        <p data-rakomi-cancelled>
          Subscription cancelled — reactivate via portal
        </p>
      )}

      {subscription.current_period_end && subscription.status !== 'cancelled' && (
        <p data-rakomi-renewal>Renews {formatDate(subscription.current_period_end)}</p>
      )}
    </div>
  );
}

export function SubscriptionManager(props: SubscriptionManagerProps): React.ReactElement {
  return (
    <AuthErrorBoundary>
      <SubscriptionManagerInner {...props} />
    </AuthErrorBoundary>
  );
}
