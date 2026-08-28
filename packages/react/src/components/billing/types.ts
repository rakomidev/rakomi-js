import type React from 'react';

import type { AppearanceConfig } from '../../appearance.js';
import type { Locale } from '../../i18n/types.js';

export interface PricingTableProps {
  tenantSlug: string;
  className?: string;
  style?: React.CSSProperties;
  appearance?: AppearanceConfig;
  locale?: Locale;
  currentPlanId?: string;
  recommendedPlanId?: string;
  emptyContent?: React.ReactNode;
  onSelectPlan?: (plan: {
    planId: string;
    planName: string;
    priceCents: number;
    currency: string;
    interval: string;
  }) => void;
}

export interface SubscriptionManagerProps {
  tenantSlug: string;
  className?: string;
  style?: React.CSSProperties;
  appearance?: AppearanceConfig;
  locale?: Locale;
  onManage?: () => void;
  onSubscriptionChange?: () => void;
  fallback?: React.ReactNode;
}

export interface CustomerPortalProps {
  tenantSlug: string;
  children?: React.ReactNode;
  returnUrl?: string;
  className?: string;
  style?: React.CSSProperties;
}
