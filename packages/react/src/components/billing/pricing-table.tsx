'use client';

import React from 'react';

import { resolveClassName, useGlobalAppearance } from '../../appearance.js';
import { useBaasPlans } from '../../hooks/use-baas-plans.js';
import { useBranding } from '../../hooks/use-branding.js';
import { AuthErrorBoundary } from '../../internal/auth-error-boundary.js';
import { applyBranding } from '../../internal/branding-styles.js';
import type { PricingTableProps } from './types.js';

function PricingTableInner(props: PricingTableProps): React.ReactElement {
  const {
    tenantSlug,
    className,
    style,
    locale,
    currentPlanId,
    recommendedPlanId,
    emptyContent,
    onSelectPlan,
  } = props;

  const { branding } = useBranding();
  const brandingStyle = applyBranding(branding);
  const globalAppearance = useGlobalAppearance();
  const cls = (element: string) => resolveClassName(element, props.appearance, globalAppearance);

  const { plans, isLoading, error } = useBaasPlans({ tenantSlug });

  const formatPrice = (priceCents: number, currency: string, interval: string): string => {
    const formatted = new Intl.NumberFormat(locale ?? 'en', {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(priceCents / 100);
    return `${formatted}/${interval}`;
  };

  if (isLoading) {
    return (
      <div
        data-rakomi-pricing-table
        style={{ ...brandingStyle, ...style }}
        className={cls('root') || className}
        aria-busy="true"
      >
        <div data-rakomi-skeleton style={{ height: '200px', background: '#f0f0f0', borderRadius: '8px' }} />
      </div>
    );
  }

  if (error) {
    return (
      <div
        data-rakomi-pricing-table
        style={{ ...brandingStyle, ...style }}
        className={cls('root') || className}
      >
        <p data-rakomi-error>Failed to load plans</p>
      </div>
    );
  }

  if (plans.length === 0) {
    return (
      <div
        data-rakomi-pricing-table
        style={{ ...brandingStyle, ...style }}
        className={cls('root') || className}
      >
        {emptyContent ?? <p>No plans available</p>}
      </div>
    );
  }

  return (
    <div
      data-rakomi-pricing-table
      style={{ ...brandingStyle, ...style }}
      className={cls('root') || className}
    >
      <ul role="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {plans.map((plan) => {
          const isCurrent = currentPlanId === plan.id;
          const isRecommended = recommendedPlanId === plan.id;
          const formattedPrice = formatPrice(plan.price_cents, plan.currency, plan.interval);

          return (
            <li
              key={plan.id}
              role="listitem"
              aria-label={`${plan.name} plan, ${formattedPrice}`}
              data-rakomi-plan-card
              data-current={isCurrent || undefined}
              data-recommended={isRecommended || undefined}
            >
              {isRecommended && (
                <span data-rakomi-badge-popular aria-label="Most popular plan">Most Popular</span>
              )}
              <h3>{plan.name}</h3>
              <p data-rakomi-price>{formattedPrice}</p>
              <p data-rakomi-currency>{plan.currency.toUpperCase()}</p>
              {plan.trial_days != null && plan.trial_days > 0 && (
                <p data-rakomi-trial>{plan.trial_days}-day free trial</p>
              )}
              {plan.features != null && plan.features.length > 0 && (
                <ul>
                  {plan.features.map((feature, i) => (
                    <li key={i}>{feature}</li>
                  ))}
                </ul>
              )}
              <button
                type="button"
                aria-disabled={isCurrent || undefined}
                disabled={isCurrent}
                onClick={() => {
                  if (!isCurrent && onSelectPlan) {
                    onSelectPlan({
                      planId: plan.id,
                      planName: plan.name,
                      priceCents: plan.price_cents,
                      currency: plan.currency,
                      interval: plan.interval,
                    });
                  }
                }}
              >
                {isCurrent ? 'Current Plan' : 'Subscribe'}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function PricingTable(props: PricingTableProps): React.ReactElement {
  return (
    <AuthErrorBoundary>
      <PricingTableInner {...props} />
    </AuthErrorBoundary>
  );
}
