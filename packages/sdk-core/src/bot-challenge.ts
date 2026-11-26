/**
 * Bot challenge (Cloudflare Turnstile) on the public auth endpoints.
 *
 * An environment can require that `POST /v1/auth/register`, `/v1/auth/login` and
 * `/v1/auth/forgot-password`, called with a publishable key, carry a `turnstile_token`: a Turnstile
 * token solved with the environment's own site key, for the action of the call (`register`,
 * `login` or `reset`), on a host of one of the environment's allowed redirect URIs.
 * `GET /v1/auth/config` tells the client whether it must (see `AuthConfig.botChallenge`).
 */

import { extractRequestId } from './internal/request-id.js';
import type { AuthError } from './types/auth-error.js';

/** The Turnstile action each endpoint expects the token to be solved for. */
export type BotChallengeAction = 'register' | 'login' | 'reset';

/**
 * Supplies a Turnstile token for one call. Called once per request, just before it is sent; a
 * Turnstile token is single-use, so return a fresh one each time. Return `undefined` when there is
 * none (the API then answers `BOT_CHALLENGE_FAILED` with reason `missing` if the environment
 * requires one).
 */
export type BotChallengeTokenProvider = (action: BotChallengeAction) => string | undefined | Promise<string | undefined>;

/** The per-call options of the endpoints that may require a bot challenge. */
export interface BotChallengeOptions {
  /** A Turnstile token solved for this call's action. Takes precedence over `turnstileTokenProvider`. */
  turnstileToken?: string;
  /** Asked for a token when `turnstileToken` is not given. */
  turnstileTokenProvider?: BotChallengeTokenProvider;
}

/** The token to send for this call, if any: the explicit one, else the provider's. */
export async function resolveBotChallengeToken(
  options: BotChallengeOptions,
  action: BotChallengeAction,
): Promise<string | undefined> {
  if (options.turnstileToken) return options.turnstileToken;
  if (!options.turnstileTokenProvider) return undefined;
  const token = await options.turnstileTokenProvider(action);
  return typeof token === 'string' && token.length > 0 ? token : undefined;
}

const REASON_BY_CODE: Readonly<Record<string, 'missing' | 'invalid' | 'unavailable'>> = {
  'bot/challenge_required': 'missing',
  'bot/challenge_failed': 'invalid',
  'bot/challenge_unavailable': 'unavailable',
};

/**
 * Maps an API problem response refusing the bot challenge to a `BOT_CHALLENGE_FAILED` error;
 * `undefined` for any other response. `missing`: no token was sent; `invalid`: the token did not
 * verify (expired, reused, solved elsewhere) — solve a new one; `unavailable`: the check could not
 * run right now — try again shortly.
 */
export function botChallengeError(body: unknown): Extract<AuthError, { code: 'BOT_CHALLENGE_FAILED' }> | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  const code = b['code'];
  if (typeof code !== 'string' || !Object.prototype.hasOwnProperty.call(REASON_BY_CODE, code)) return undefined;
  const reason = REASON_BY_CODE[code]!;
  const detail = typeof b['detail'] === 'string' ? b['detail'] : 'Security challenge failed. Please try again.';
  const requestId = extractRequestId(body);
  return { code: 'BOT_CHALLENGE_FAILED', reason, message: detail, ...(requestId ? { requestId } : {}) };
}

/** `GET /v1/auth/config` site keys are short opaque strings; anything else is not rendered. */
const SITE_KEY_SHAPE = /^[A-Za-z0-9_-]{1,128}$/;

/** Reads the bot-challenge fields of the `GET /v1/auth/config` wire response. */
export function parseBotChallengeConfig(raw: Record<string, unknown>): { siteKey: string } | undefined {
  if (raw['bot_challenge_required'] !== true) return undefined;
  const siteKey = raw['bot_challenge_site_key'];
  return typeof siteKey === 'string' && SITE_KEY_SHAPE.test(siteKey) ? { siteKey } : undefined;
}
