/**
 * @rakomi/react — TypeScript type definitions.
 *
 * Re-exports safe types from @rakomi/node (types-only — erased at compile time).
 * Defines all React SDK-specific types: AuthState, AuthError, SignInResult, etc.
 *
 * SECURITY: raw `token` string not exposed on AuthState — use getToken instead.
 * Forward-compatible with DPoP (RFC 9449): getToken returns TokenResult with headers.
 */

import type { OrgMembership, SdkError, TokenPayload, VerifyResult } from '@rakomi/node';
export type { OrgMembership, SdkError, TokenPayload, VerifyResult };

/** Request body for an anonymous sign-in. */
export interface AnonymousSigninRequest {
  public_metadata?: Record<string, unknown>;
}
/** Response payload from a successful anonymous sign-in. */
export interface AnonymousSigninResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: 'Bearer';
  user: {
    id: string;
    is_anonymous: true;
    created_at: string;
  };
}

import type { AuthError as CoreAuthError } from '@rakomi/sdk-core';
export type AuthError = CoreAuthError;
export { getErrorMessage } from '@rakomi/sdk-core';

export interface OrgContext {
  orgId: string;
  orgRole: string;
  orgMemberships: OrgMembership[];
}

export type SwitchOrgResult =
  | { status: 'complete' }
  | { status: 'error'; error: AuthError }
  | { status: 'mfa_required' }
  | { status: 'sso_required' };

export type TabSyncMessage =
  | { type: 'TOKEN_REFRESHED' }
  | { type: 'SIGNED_OUT' };

import type { AuthEvent as CoreAuthEvent } from '@rakomi/sdk-core';
export type AuthEvent = CoreAuthEvent;

/**
 * Decoded JWT user claims (no signature verification — standard SPA practice).
 * Generic T allows extending with custom claims (forward-compatible with future claim shapes).
 * rawClaims passes through ALL decoded JWT fields for unknown/custom claims.
 */
export interface UserResource {
  id: string;
  email: string;
  tenantId: string;
  roles: string[];
  permissions: string[];
  mfaVerified?: boolean;
  mfaVerifiedAt?: string;
  amr?: string[];
  acr?: string;
  /**
 * True when the underlying JWT carries `is_anonymous: true`.
 * Derived from the verified access token via decodeAccessToken — NEVER
 * trust this flag from URL/localStorage/any non-JWT source.
 */
  isAnonymous?: boolean;
  rawClaims: Record<string, unknown>;
}

export interface SessionResource {
  id: string;
  userId: string;
  tenantId: string;
  /** Calculated as Date.now() + expires_in * 1000 (clock-skew immune, not from JWT exp) */
  expiresAt: number;
  /** From token iat claim */
  lastActiveAt: number;
  /**
 * Absolute session end from `session_max_lifetime_exp` JWT claim (Unix ms).
 * Present only when tenant has a custom max lifetime policy.
 * Unlike expiresAt (auto-refresh handles it), this is permanent — user WILL be signed out.
 */
  maxLifetimeExpiresAt?: number;
  /**
 * min(expiresAt, maxLifetimeExpiresAt ?? Infinity) — "when will user lose access?"
 * Use this for isExpiringSoon computations — it reflects the BINDING constraint.
 */
  effectiveExpiresAt: number;
  /**
 * Remaining seconds until effectiveExpiresAt (render-time snapshot, NOT a live counter).
 * For a live countdown UI, use your own setInterval(1000) calling useSession each tick.
 * Stale snapshot caveat: frozen at render time — does not update until next re-render.
 */
  expiresInSeconds: number;
  /**
 * True when session will effectively expire within the configured threshold.
 * Reactive: transitions false→true via a centralized setTimeout in TokenManager.
 * Resets to false after successful token refresh.
 *
 * Short TTL note: if accessTokenTtl ≈ threshold, isExpiringSoon may be permanently true.
 * Set threshold to less than half the access token TTL for meaningful warnings.
 */
  isExpiringSoon: boolean;
}

export interface SignInOptions {
  /**
 * - 'redirect': OAuth redirect flow with PKCE.
 * - 'direct': POST /v1/auth/login (email + password).
 * - 'anonymous': POST /v1/auth/anonymous — creates a guest session.
 *
 * Default: 'direct'.
 */
  mode?: 'redirect' | 'direct' | 'anonymous';
  email?: string;
  password?: string;
  returnTo?: string;
  /**
 * Tenant-supplied metadata attached to the anonymous user row.
 * Only considered when mode === 'anonymous'. ≤1 KB, no PII keys.
 */
  publicMetadata?: Record<string, unknown>;
}

/**
 * Multi-step sign-in result (forward-compatible with MFA, email verification).
 */
export type SignInResult =
  | { status: 'complete' }
  | { status: 'redirect' }
  | { status: 'error'; error: AuthError }
  | { status: 'mfa_required'; challengeToken: string; expiresIn: number }
  | { status: 'mfa_setup_required'; graceDeadlineAt: string }
  | { status: 'magic_link_sent'; resendAfterSeconds: number }
  | { status: 'email_otp_sent'; resendAfterSeconds: number; expiresAt: string }
  | { status: 'email_verification_required' };

/**
 * Registration result — multi-step (verify email after registration).
 */
export type RegisterResult =
  | { status: 'verification_required' }
  | { status: 'error'; error: AuthError };

/**
 * getToken return type — forward-compatible with DPoP (RFC 9449).
 * v1: headers is empty. Future DPoP: headers = { DPoP: '<proof>' }.
 */
export type TokenResult =
  | {
      ok: true;
      token: string;
      tokenType: 'Bearer';
      headers: Record<string, string>;
      /** Remaining seconds until expiry — recomputed per getToken() call */
      expiresIn: number;
    }
  | { ok: false; error: AuthError };

/**
 * Discriminated union return type from useAuth.
 * 3-state: loading | signed-out | signed-in.
 * Forces correct null-checking in TypeScript.
 *
 * Generic T for custom JWT claims (forward-compatible with future claim shapes).
 */
export type AuthState<T extends Record<string, unknown> = Record<never, never>> =
  | {
      isLoaded: false;
      isSignedIn: undefined;
      userId: undefined;
      user: undefined;
      sessionId: undefined;
      error: null;
      signIn: (options?: SignInOptions) => Promise<SignInResult>;
      signOut: () => Promise<void>;
      getToken: () => Promise<TokenResult>;
    }
  | {
      isLoaded: true;
      isSignedIn: false;
      userId: null;
      user: null;
      sessionId: null;
      error: AuthError | null;
      signIn: (options?: SignInOptions) => Promise<SignInResult>;
      signOut: () => Promise<void>;
      getToken: () => Promise<TokenResult>;
    }
  | {
      isLoaded: true;
      isSignedIn: true;
      userId: string;
      user: UserResource & T;
      sessionId: string;
      /** null normally; AuthError during network-error retry (isSignedIn stays true with stale token) */
      error: AuthError | null;
      /** Unified check for permissions and roles. Wildcard-aware. */
      has: (params: HasParams) => boolean;
      /**
 * True when session will expire within the configured threshold.
 * Source: centralized TokenManager timer — reactive, NOT re-computed per render.
 * Use session.isExpiringSoon (from useSession) for full session metadata.
 */
      isExpiringSoon: boolean;
      signIn: (options?: SignInOptions) => Promise<SignInResult>;
      signOut: () => Promise<void>;
      getToken: () => Promise<TokenResult>;
      switchOrganization: (orgId: string | null) => Promise<SwitchOrgResult>;
    };

/**
 * Parameters for AuthState.has() — unified authorization check.
 * Supports permission and role checks. Future: featureFlag, plan.
 */
export interface HasParams {
  permission?: string;
  role?: string;
}

/**
 * Branding configuration from tenant settings (Pro+ feature).
 * Returned in GET /v1/auth/config when tenant has custom branding.
 */
export interface BrandingConfig {
  logoUrl?: string;
  primaryColor?: string;
  backgroundColor?: string;
  buttonColor?: string;
  textColor?: string;
  borderRadius?: string;
  tenantName: string;
}

/**
 * Tenant auth configuration returned by GET /v1/auth/config.
 * Used by pre-built components to auto-discover available auth methods.
 */
export interface AuthConfig {
  methods: string[];
  socialProviders: string[];
  mfaEnforced: boolean;
  mfaGracePeriodHours?: number;
  branding?: BrandingConfig;
}

export interface SessionInfo {
  id: string;
  userAgent: string;
  ipHash: string;
  createdAt: string;
  lastUsedAt: string;
  isCurrent: boolean;
}

/**
 * Async-compatible storage interface (supports React Native expo-secure-store via Promise return).
 */
export interface TokenStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

export interface InitialAuthState {
  userId?: string;
  sessionId?: string;
}

export interface RakomiProviderProps {
  clientId?: string;
  baseUrl?: string;
  redirectUrl?: string;
  persistence?: 'session' | 'local' | 'memory';
  storage?: TokenStorage;
  initialState?: InitialAuthState;
  onRedirectCallback?: (appState: { returnTo?: string }) => void;
  onAuthEvent?: (event: AuthEvent) => void;
  /** Minutes of inactivity before auto-signOut. For HIPAA: 15 minutes. */
  sessionTimeout?: number;
  /**
 * Minutes before session expiry when isExpiringSoon becomes true.
 * Default: 5 minutes. Range: 1–60 (out-of-range values clamped with console.warn).
 * Set this to less than half your access token TTL for meaningful warnings.
 * For PCI DSS 4.0 §8.2.8 (15 min idle): use expiringThresholdMinutes=15.
 */
  expiringThresholdMinutes?: number;
  /** i18n locale for pre-built components. Default: 'en'. widened to 5 GA locales. */
  locale?: 'en' | 'pl' | 'de' | 'fr' | 'es';
  /**
   * Optional per-app translation overrides. Merged on top of the selected locale
   * (priority: `translations` > locale dictionary > English fallback).
   * Pass `Partial<Translations>` — unspecified keys fall through.
   */
  translations?: Partial<import('./i18n/types.js').Translations>;
  /** Color scheme for pre-built components. Default: 'auto' (prefers-color-scheme) */
  colorScheme?: 'light' | 'dark' | 'auto';
  /** Global appearance context for pre-built components */
  appearance?: { elements?: Record<string, string> };
  /**
   * Override or supplement API-fetched branding. Prop values win per-field (merge).
   * For best performance, memoize: `const b = useMemo(() => ({ ... }), [])`.
   */
  branding?: Partial<BrandingConfig>;
  children: React.ReactNode;
}

export interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}
