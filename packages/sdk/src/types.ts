/** Environment mode for error verbosity in middleware responses. */
export type SdkEnvironment = 'development' | 'production';

/**
 * SDK configuration options for Rakomi client.
 */
export interface RakomiConfig {
  /** API key (must start with `ca_live_` or `ca_test_`) */
  apiKey: string;
  /** Base URL for the Rakomi API (defaults to https://api.rakomi.com) */
  baseUrl?: string;
  /** Clock tolerance in seconds for JWT expiry checks (default: 30, max: 120) */
  clockTolerance?: number;
  /** Override environment detection (default: auto-detect from request hostname) */
  environment?: SdkEnvironment;
  /** Webhook signing secret from Rakomi dashboard (per-tenant) */
  webhookSecret?: string;
  /** Webhook timestamp tolerance in seconds (default: 300, max: 600) */
  webhookTolerance?: number;
  /** OAuth client ID (required for exchangeCode/refreshToken) */
  clientId?: string;
  /** OAuth client secret (required for exchangeCode/refreshToken) */
  clientSecret?: string;
}

/**
 * Session metadata — computed from JWT claims after successful verifyToken.
 * Provides session lifecycle information for building session-aware UIs.
 *
 * isExpiringSoon uses effectiveExpiresIn = min(token.expiresIn, maxLifetimeRemaining)
 * to match React SDK formula and prevent Next.js SSR hydration mismatch.
 *
 * Clock skew note: expiresAt/isExpiringSoon are computed from exp - now. If the verifying
 * server's clock differs from the signing server, values may be slightly off. React SDK is
 * immune — it uses expires_in from the token response body (relative, clock-skew free).
 */
export interface SessionMetadata {
  /** ISO 8601: when the access token expires (from JWT exp claim). Auto-refresh handles this. */
  expiresAt: string;
  /**
   * ISO 8601: absolute session end. Present only when tenant has a custom max lifetime policy.
   * Unlike expiresAt, this CANNOT be auto-refreshed — the user WILL be signed out.
   */
  maxLifetimeExpiresAt?: string;
  /**
   * True when the session will effectively expire in less than 300 seconds.
   * Computed as min(token.expiresIn, maxLifetimeRemainingSeconds) < 300.
   * Hardcoded 300s for server-side (React SDK configurable via expiringThresholdMinutes).
   */
  isExpiringSoon: boolean;
}

/**
 * Token metadata — computed from JWT claims after successful verifyToken().
 *
 * expiresIn is subject to clock skew between the signing server and verifying server.
 * Use for approximate remaining time in server-side rendering (e.g., prefill caches).
 * For client-side use, prefer the React SDK's expiresInSeconds which is clock-skew immune.
 */
export interface TokenMetadata {
  /** Remaining seconds until the access token expires. Clamped to 0 (never negative). */
  expiresIn: number;
}

/** A single org membership entry from the org_memberships JWT claim. */
export interface OrgMembership {
  org_id: string;
  org_slug: string;
  org_role: string;
  membership_public_metadata?: Record<string, unknown>;
}

/**
 * Decoded JWT token payload with camelCase surface.
 * Maps from JWT snake_case claims: sub→userId, tenant_id→tenantId, sid→sessionId.
 */
export interface TokenPayload {
  userId: string;
  /** User email. Absent for M2M tokens (client_credentials flow has no user context). */
  email?: string;
  tenantId: string;
  /** Session ID. Absent for M2M tokens (client_credentials flow creates no session). */
  sessionId?: string;
  iss: string;
  aud: string;
  exp: number;
  iat: number;
  jti: string;
  /** True when user authenticated with a second factor (TOTP or recovery code). Omitted if false. */
  mfaVerified?: boolean;
  /** ISO 8601 timestamp of the MFA verification. Preserved across token refreshes. */
  mfaVerifiedAt?: string;
  /** Authentication Method Reference (RFC 8176). e.g. ['pwd'], ['pwd', 'otp', 'mfa'] */
  amr?: string[];
  /** Authentication Context Class Reference (OIDC Core). 'aal1' = single-factor, 'aal2' = multi-factor.
 * 'eidas_high' when the user authenticated via an EU Digital Identity Wallet. */
  acr?: string;
  /** EU member-state issuer of the verified credential (EUDI Wallet login). */
  credential_issuer?: string;
  /** VERIFIED eIDAS level of assurance from the credential ('low'|'substantial'|'high'). */
  assurance_level?: 'low' | 'substantial' | 'high';
  /** Unix timestamp of initial authentication. Stays constant across token refreshes (RFC 9470). */
  authTime?: number;
  /** RBAC role keys assigned to the user (immutable slugs, e.g. ['editor', 'moderator']) */
  roles: string[];
  /** Deduplicated, sorted permission strings from all assigned roles (e.g. ['posts:read', 'posts:write']) */
  permissions: string[];
  /** Environment slug from rkm_env JWT claim ('live' or 'test'). Absent in pre-15.4 tokens. */
  environment?: string;
  /**
 * Custom public metadata from the public_metadata JWT claim.
 * Present only when non-empty and under 1 KB. Absent from M2M tokens.
 * WARNING: Do not use for authorization decisions — informational only.
 */
  publicMetadata?: Record<string, unknown>;
  /**
 * GDPR Art. 8 minor flag from the `is_minor` JWT claim.
 * ADVISORY ONLY — a derived snapshot HINT, NOT an authorization signal. Enforce minor-protection
 * rules server-side (re-derive from the source age signal). Present only when the platform has
 * computed it (bi-state true/false); ABSENT when minor protection is off or not yet computed — so
 * `undefined` is distinct from `false`. The date of birth is NEVER present in the token.
 */
  isMinor?: boolean;
  /**
 * Session lifecycle metadata. Optional for forward-compatibility with M2M tokens
 * (client_credentials flow has no session concept). Always present for user tokens.
 */
  session?: SessionMetadata;
  /**
 * Token metadata. Optional for forward-compatibility with M2M tokens.
 * Always present for user tokens after successful verifyToken.
 */
  token?: TokenMetadata;
  /**
 * BaaS subscription claim. Present only for end-users with an active BaaS subscription.
 * Absent from M2M tokens and from user tokens when no active subscription exists.
 */
  subscription?: {
    plan_id: string;
    plan_name: string;
    status: string;
    current_period_end: string | null;
  };
  /** Active organization context. Null = no active org (personal mode). Set in (org switching). */
  org_id?: string | null;
  /** Caller's role in the active org. Null when org_id is null. */
  org_role?: string | null;
  /** All org memberships for this user (present when serialized size < 1KB). */
  org_memberships?: OrgMembership[];
  /** True when this is an M2M token (client_credentials grant). Reliable marker — do not rely on absence of sessionId. */
  isM2M?: boolean;
  /** OAuth client ID (service identity). Present on M2M tokens only. */
  clientId?: string;
  /** Granted scopes as array. Present on M2M tokens; use auth.scopes.includes('api:read') for M2M permission checks. */
  scopes?: string[];
  /**
   * True when this is an agent token issued via the RFC 8693 token-exchange
   * grant. The token represents an AI agent acting on behalf of the human
   * `sub` user — `userId`/`email` still identify the human; `agent` carries
   * the acting client's identity. Reliable marker for "agent-mediated action"
   * audit / authorization decisions.
   */
  isAgentToken?: boolean;
  /**
 * agent identity present iff `isAgentToken === true`. Derived
 * from the `act.sub` claim (the agent client's `client_id`) plus the
 * narrowed `scope` claim.
 */
  agent?: {
    /** Agent client's `client_id` (registered in dashboard as `clientType: 'agent'`). */
    clientId: string;
    /** Narrowed scope set granted to this agent token (subset of original user scopes). */
    scopes: string[];
  };
}

/**
 * Enriched SDK error with actionable developer guidance.
 */
export interface SdkError {
  code: string;
  message: string;
  suggestion: string;
  docs_url: string;
  fix_command?: string;
}

/**
 * Result type — verifyToken() and verifyWebhook() NEVER throw, always return this.
 */
export type VerifyResult<T = TokenPayload> =
  | { ok: true; data: T }
  | { ok: false; error: SdkError };

/**
 * Webhook event payload delivered by Rakomi.
 */
export interface WebhookEvent {
  /** Delivery ID from X-Rakomi-Delivery-Id */
  id: string;
  /** Event type (dot.lowercase, e.g. `user.created`) */
  type: string;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Tenant ID */
  tenantId: string;
  /** User ID (optional for system events) */
  userId?: string;
  /** Event severity */
  severity: 'critical' | 'warning' | 'info';
  /** Event-specific data */
  data: Record<string, unknown>;
  /** Event metadata */
  meta: {
    api_version: string;
    event_language?: string;
    tenant_country?: string;
    user_country?: string;
  };
}

/**
 * Webhook headers sent with each delivery (Standard Webhooks + Rakomi supplementary).
 * Accepts both exact header names and raw Express headers (lowercased).
 */
export type WebhookHeaders =
  | {
      'webhook-id': string;
      'webhook-signature': string;
      'webhook-timestamp': string;
      'x-rakomi-delivery-id'?: string;
      'x-rakomi-event'?: string;
      'x-rakomi-attempt'?: string;
    }
  | Record<string, string | string[] | undefined>;

/**
 * Verified webhook data returned on successful verification.
 */
export interface WebhookVerifyData<T = WebhookEvent> {
  /**
 * Standard Webhooks `webhook-id` header — the stable message identity, constant across all retry
 * attempts of a delivery. This is the canonical at-least-once **dedup key** for idempotent
 * processing. Surfaced for BOTH the tenant and publisher transports; always
 * present since `webhook-id` is a required header.
 */
  webhookId: string;
  /**
   * Per-delivery id from `X-Rakomi-Delivery-Id` (falls back to `webhook-id` when absent). Stable
   * across retries of a delivery row but NOT across a reconcile re-enqueue — use for diagnostics /
   * logging, NOT as the primary idempotency key (prefer {@link webhookId}).
   */
  deliveryId: string;
  timestamp: number;
  payload: T;
}

/**
 * Publisher webhook event types (transport-eligible + best-effort publisher-scoped).
 * The three audit-only / NOT-webhook-delivered types
 * (`publisher.subprocessor_added`/`_removed`, `compliance.pack_exported`) are deliberately
 * EXCLUDED — a receiver never gets them over the transport.
 *
 * @public — additive-only after the first public release (a removed/renamed member is a MAJOR bump).
 */
export type PublisherEventType =
  | 'app.installed'
  | 'app.uninstalled'
  | 'app.install.scope_bump'
  | 'app.install.receipts_revoked'
  | 'publisher.created'
  | 'publisher.domain_verified'
  | 'publisher.dpa_accepted'
  | 'app.created'
  | 'app.version_published'
  | 'app.state_changed'
  | 'publisher.review_requested'
  | 'publisher.review_denied'
  | 'publisher.review_stale'
  | 'publisher.verified'
  | 'publisher.deverified'
  | 'publisher.subscription_activated'
  | 'publisher.subscription_lapsed';

/**
 * Open-set publisher event type: the known-literal union widened with the base string so a delivery
 * carrying a `type` an older SDK has never heard of still verifies and is well-typed (forward-compat
 * on the event-catalog axis). `(string & {})` keeps literal autocomplete while accepting unknown strings.
 *
 * @public — additive-only after the first public release.
 */
export type PublisherWebhookEventType = PublisherEventType | (string & {});

/**
 * The flat publisher-webhook delivery body (the parsed JSON the receiver gets on the wire). Only
 * `publisher_id` + `correlation_id` are always present; the install-scoped fields appear on
 * install-scoped events. Unknown/additional fields are TOLERATED (forward-compat on the payload axis)
 * the verifier authenticates the bytes, then exposes the parsed object without rejecting extra keys.
 * Contains NO end-user PII (operational references / counts only grounding).
 *
 * @public — additive-only after the first public release.
 */
export interface PublisherWebhookEvent {
  /** Publisher that owns the app / endpoint (resolved server-side, never caller input). */
  publisher_id: string;
  /** Stable cross-table forensic join key (v4) — preserved across reconcile re-enqueue. */
  correlation_id: string;
  /** install-scoped events only. */
  installation_id?: string;
  app_id?: string;
  app_version_id?: string;
  /** Who/what drove the action (`tenant_admin` | `system_drain` | `system_expiry`). */
  actor_axis?: string;
  /** `app.install.scope_bump` only — the install-state transition. */
  install_state_from?: string;
  install_state_to?: string;
  /** `app.install.receipts_revoked` only. */
  revoked_count?: number;
  already_revoked_count?: number;
  /** Forward-compat: additive sender-side fields are tolerated, never rejected. */
  [key: string]: unknown;
}

/**
 * Verified publisher-webhook data returned by `verifyPublisherWebhook` on success. Extends the
 * generic verify shape with `eventType` (from the `X-Rakomi-Event` header — the exhaustive
 * `switch (data.eventType)` discriminant) and narrows `payload` to {@link PublisherWebhookEvent}.
 *
 * @public — additive-only after the first public release.
 */
export interface PublisherWebhookVerifyData {
  /** Stable Standard Webhooks message id — the at-least-once dedup key. */
  webhookId: string;
  /** Per-delivery id (diagnostics/logging) — prefer {@link webhookId} for dedup. */
  deliveryId: string;
  /** Event type from the `X-Rakomi-Event` header (open set). */
  eventType: PublisherWebhookEventType;
  /** Unix seconds from `webhook-timestamp`. */
  timestamp: number;
  /** The flat, verified delivery body. */
  payload: PublisherWebhookEvent;
}

/**
 * Options for Express-compatible middleware.
 */
export interface MiddlewareOptions {
  onError?: (error: SdkError, req: unknown, res: unknown) => void;
}

import type { DpopSession } from './dpop-session.js';

/** PKCE challenge pair for OAuth authorization code flow. */
export interface PkceChallenge {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
}

/** Options for building an OAuth authorize URL. */
export interface AuthorizeUrlOptions {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  scope?: string | string[];
  baseUrl?: string;
}

/** Token response from OAuth token endpoint. */
export interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

/**
 * Result of a successful in-band DPoP refresh-key ROTATION ({@link rotateRefreshKey}).
 * Extends {@link OAuthTokenResponse} with the {@link rotated} discriminant so the
 * caller can tell whether the key actually re-bound.
 *
 * **Why a discriminant and not a bare success/error:** the rotation request
 * is, on the wire, a `grant_type=refresh_token` POST — on a one-time-use refresh
 * token server (the Rakomi contract) EVERY 200 consumes the presented token and
 * issues a fresh one in the body, *whether or not the server applied the rotation*.
 * A rotation-unaware server therefore returns a perfectly good refreshed session
 * that simply did NOT re-key.
 * The SDK MUST surface that body, never discard it — discarding it leaves the caller
 * holding the now-consumed (dead) token, and the next refresh trips server
 * refresh-reuse detection → nuclear logout (the exact backward-safety property
 * the dual-header design exists to provide for a rotation-unaware server).
 *
 * @public — additive-only after the first public release.
 */
export interface RotationTokenResponse extends OAuthTokenResponse {
  /**
   * Whether the server actually re-bound the session to the NEW key.
   *
   * - `true` — the server confirmed the rotation (a 200 whose access-token `cnf.jkt`
   *   equals the new key's thumbprint); the SDK has atomically swapped its active
   *   prover to the new key. Persist these tokens; the new key is now bound.
   * - `false` — the refresh SUCCEEDED and these are fresh, live tokens, but the key
   *   was NOT rotated (a rotation-unaware server, or a transport that
   *   stripped the `DPoP-Rotate` header). The OLD key is still bound (no half-swap).
   *   **You MUST persist the returned `refresh_token`** — the one you presented was
   *   consumed (one-time-use) and is now dead; the old key remains live. Re-attempt
   *   the rotation later if you still need to re-key.
   */
  rotated: boolean;
}

/** Options for exchanging an authorization code for tokens. */
export interface OAuthExchangeOptions {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientId?: string;
  /** Required for confidential clients. Omit for public clients (PKCE is sole proof). */
  clientSecret?: string;
  baseUrl?: string;
  /**
   * Opt a session into RFC 9449 DPoP sender-constraint. When
   * provided, `exchangeCode` attaches a DPoP proof so the server binds the
   * session's `dpop_jkt` to this handle's keypair at issuance — the precondition
   * that makes the FIRST refresh of a bound session succeed. Pass the SAME
   * {@link DpopSession} to every subsequent `refreshToken` for this session.
   * Omit for a Bearer session.
   */
  dpop?: DpopSession;
}

/** Options for refreshing an OAuth token. */
export interface OAuthRefreshOptions {
  refreshToken: string;
  clientId?: string;
  /** Required for confidential clients. Omit for public clients (PKCE is sole proof). */
  clientSecret?: string;
  baseUrl?: string;
  /**
   * The same {@link DpopSession} that was passed to `exchangeCode` for this
   * session. A DPoP proof is attached on refresh IFF the server has confirmed
   * the session is bound (`token_type === "DPoP"`); a Bearer session attaches
   * no proof even when a session is supplied (follow the server's signal, not
   * the SDK's capability). Omit for a Bearer session.
   */
  dpop?: DpopSession;
}

/**
 * Options for an in-band DPoP refresh-key ROTATION
 * Distinct from {@link
 * OAuthRefreshOptions} BY API SHAPE: rotation is a dedicated, explicit ceremony
 * ({@link rotateRefreshKey}) — never a flag on an ordinary refresh — so a
 * `DPoP-Rotate` header is structurally impossible to attach speculatively
 * `dpop` is REQUIRED and MUST be a server-confirmed bound session: you
 * cannot re-key a session whose current key the server has not bound.
 */
export interface OAuthRotateOptions {
  refreshToken: string;
  clientId?: string;
  /** Required for confidential clients. Omit for public clients (PKCE is sole proof). */
  clientSecret?: string;
  baseUrl?: string;
  /**
   * The bound {@link DpopSession} whose key is being rotated. The SDK builds an
   * OLD-key proof (this session's current prover, proving the right to rotate)
   * AND a NEW-key proof (a fresh ephemeral keypair) and co-presents them on one
   * refresh request; the active prover is swapped to the new key ONLY after the
   * server confirms a `cnf.jkt`-matched 200.
   */
  dpop: DpopSession;
}
