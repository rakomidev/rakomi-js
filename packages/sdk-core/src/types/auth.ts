/**
 * Platform-neutral auth types — single source of truth for `@rakomi/react` and `@rakomi/react-native`.
 * Re-exported from each platform package; consumer code is portable.
 */

import type { AuthError } from './auth-error.js';

/** Decoded JWT user claims. Generic `T` allows tenant-defined extension claims. */
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
  /** c: anonymous JWT carries `is_anonymous: true`. NEVER trust outside the verified token. */
  isAnonymous?: boolean;
  rawClaims: Record<string, unknown>;
}

export interface SessionResource {
  id: string;
  userId: string;
  tenantId: string;
  expiresAt: number;
  lastActiveAt: number;
  maxLifetimeExpiresAt?: number;
  effectiveExpiresAt: number;
  expiresInSeconds: number;
  isExpiringSoon: boolean;
}

export interface SessionInfo {
  id: string;
  userAgent: string;
  ipHash: string;
  createdAt: string;
  lastUsedAt: string;
  isCurrent: boolean;
}

export interface SignInOptions {
  mode?: 'redirect' | 'direct' | 'anonymous';
  email?: string;
  password?: string;
  returnTo?: string;
  publicMetadata?: Record<string, unknown>;
}

export type SignInResult =
  | { status: 'complete' }
  | { status: 'redirect' }
  | { status: 'error'; error: AuthError }
  | { status: 'mfa_required'; challengeToken: string; expiresIn: number }
  | { status: 'mfa_setup_required'; graceDeadlineAt: string }
  | { status: 'magic_link_sent'; resendAfterSeconds: number }
  | { status: 'email_otp_sent'; resendAfterSeconds: number; expiresAt: string }
  | { status: 'email_verification_required' };

export type RegisterResult =
  | { status: 'verification_required' }
  | { status: 'error'; error: AuthError };

export type SwitchOrgResult =
  | { status: 'complete' }
  | { status: 'error'; error: AuthError }
  | { status: 'mfa_required' }
  | { status: 'sso_required' };

export type TokenResult =
  | { ok: true; token: string; tokenType: 'Bearer'; headers: Record<string, string>; expiresIn: number }
  | { ok: false; error: AuthError };

/**
 * Discrete auth states for FSM-style consumer UI. Parity-tested 1:1 with `@rakomi/react`.
 */
export type AuthMachineState =
  | 'idle'
  | 'authenticating'
  | 'awaiting_mfa'
  | 'authenticated'
  | 'refreshing'
  | 'offline_stale'
  | 'error';

export interface OrgMembership {
  orgId: string;
  role: string;
}

export interface OrgContext {
  orgId: string;
  orgRole: string;
  orgMemberships: OrgMembership[];
}

export interface HasParams {
  permission?: string;
  role?: string;
}

export interface BrandingConfig {
  logoUrl?: string;
  primaryColor?: string;
  backgroundColor?: string;
  buttonColor?: string;
  textColor?: string;
  borderRadius?: string;
  tenantName: string;
}

export interface AuthConfig {
  methods: string[];
  socialProviders: string[];
  mfaEnforced: boolean;
  mfaGracePeriodHours?: number;
  branding?: BrandingConfig;
}

export interface AuthEvent {
  type:
    | 'initialized'
    | 'restore_attempted'
    | 'restore_succeeded'
    | 'restore_failed'
    | 'token_received'
    | 'refresh_started'
    | 'refresh_succeeded'
    | 'refresh_failed'
    | 'sign_in_attempted'
    | 'sign_in_failed'
    | 'signed_in'
    | 'signed_out'
    | 'tab_sync_received'
    | 'lock_acquired'
    | 'lock_timeout'
    | 'network_retry'
    | 'preflight_complete'
    | 'session_mismatch'
    | 'bfcache_restore'
    | 'component_step_changed'
    | 'component_error'
    | 'consent_granted'
    | 'invalid_context'
    | 'session_expiring_soon'
    | 'biometric_failed'
    | 'offline_queue_drained'
    | 'clock_skew_detected'
    | 'app_state_foreground'
    | 'deep_link_received';
  severity: 'info' | 'warning' | 'security';
  timestamp: number;
  duration?: number;
  tabId: string;
  error?: AuthError;
  metadata?: Record<string, unknown>;
}

export interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

export interface InitialAuthState {
  userId?: string;
  sessionId?: string;
}
