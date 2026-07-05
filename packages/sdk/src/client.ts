import { AgentsClient } from './agents.js';
import {
  anonymousSignin,
  type AnonymousSigninOptions,
  type AnonymousSigninResult,
} from './anonymous.js';
import {
  awaitCibaDecision as awaitCibaDecisionImpl,
  type CibaAwaitDecisionOptions,
  type CibaInitiateOptions,
  type CibaInitiateResponse,
  type CibaPollResponse,
  initiateCiba as initiateCibaImpl,
  pollCiba as pollCibaImpl,
} from './ciba.js';
import { CredentialsClient } from './credentials.js';
import {
  CONFIG_INVALID_BASE_URL,
  CONFIG_MISSING_API_KEY,
  CONFIG_MISSING_WEBHOOK_SECRET,
  OAUTH_MISSING_CLIENT_ID,
  RakomiError,
} from './errors.js';
import { FlagsClient } from './flags.js';
import { JwksCache } from './jwks-cache.js';
import { LinkClient } from './link.js';
import type { MiddlewareRequest, MiddlewareResponse, NextFunction } from './middleware.js';
import { createMiddleware } from './middleware.js';
import {
  buildAuthorizeUrl as buildAuthorizeUrlImpl,
  exchangeCode as exchangeCodeImpl,
  generatePKCE as generatePKCEImpl,
  generateState as generateStateImpl,
  refreshToken as refreshTokenImpl,
} from './oauth.js';
import {
  exchangeTokenOrThrow as exchangeTokenOrThrowImpl,
  exchangeTokenViaApi as exchangeTokenViaApiImpl,
  type TokenExchangeOptions,
  type TokenExchangeResponse,
} from './token-exchange.js';
import type {
  AuthorizeUrlOptions,
  MiddlewareOptions,
  OAuthExchangeOptions,
  OAuthRefreshOptions,
  OAuthTokenResponse,
  PkceChallenge,
  RakomiConfig,
  SdkEnvironment,
  TokenPayload,
  VerifyResult,
  WebhookEvent,
  WebhookVerifyData,
} from './types.js';
import { verifyToken } from './verify-token.js';
import { verifyWebhook as verifyWebhookImpl } from './verify-webhook.js';

const DEFAULT_BASE_URL = 'https://api.rakomi.com';
const DEFAULT_CLOCK_TOLERANCE = 30;
const MAX_CLOCK_TOLERANCE = 120;
const DEFAULT_WEBHOOK_TOLERANCE = 300;
const MAX_WEBHOOK_TOLERANCE = 600;
const API_KEY_PREFIXES = ['ca_live_', 'ca_test_', 'akm_live_', 'akm_test_'];

export class RakomiClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly clockTolerance: number;
  private readonly environment?: SdkEnvironment;
  private readonly webhookSecret?: string;
  private readonly webhookTolerance: number;
  private readonly clientId?: string;
  private readonly clientSecret?: string;
  private jwksCache: JwksCache | null = null;
  readonly flags: FlagsClient;
  /** Verifiable Credentials issuance (tenant server-to-server). */
  readonly credentials: CredentialsClient;
  /** c: user-scoped account-linking resource. Requires end-user JWT per call. */
  readonly link: LinkClient;
  /** end-user agent management (`users.me.agents.list/.revoke`). Requires end-user JWT per call. */
  readonly users: { readonly me: { readonly agents: AgentsClient } };

  constructor(config: RakomiConfig) {
    if (!config.apiKey) {
      throw new RakomiError(CONFIG_MISSING_API_KEY());
    }
    if (!API_KEY_PREFIXES.some((prefix) => config.apiKey.startsWith(prefix))) {
      throw new RakomiError(CONFIG_MISSING_API_KEY());
    }
    this.apiKey = config.apiKey;

    if (config.baseUrl !== undefined) {
      let url: URL;
      try {
        url = new URL(config.baseUrl);
      } catch {
        throw new RakomiError(CONFIG_INVALID_BASE_URL());
      }
      const isLocalhost = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
      if (url.protocol !== 'https:' && !isLocalhost) {
        throw new RakomiError(CONFIG_INVALID_BASE_URL());
      }
      let end = config.baseUrl.length;
      while (end > 0 && config.baseUrl.charCodeAt(end - 1) === 47) end--;
      this.baseUrl = config.baseUrl.slice(0, end);
    } else {
      this.baseUrl = DEFAULT_BASE_URL;
    }

    const tolerance = config.clockTolerance ?? DEFAULT_CLOCK_TOLERANCE;
    this.clockTolerance = Math.min(Math.max(0, tolerance), MAX_CLOCK_TOLERANCE);

    this.environment = config.environment;

    this.webhookSecret = config.webhookSecret;
    const whTolerance = config.webhookTolerance ?? DEFAULT_WEBHOOK_TOLERANCE;
    this.webhookTolerance = Math.min(Math.max(0, whTolerance), MAX_WEBHOOK_TOLERANCE);

    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;

    this.flags = new FlagsClient(this.baseUrl, this.apiKey);

    this.credentials = new CredentialsClient(this.baseUrl, this.apiKey);

    this.link = new LinkClient({ baseUrl: this.baseUrl });

    this.users = { me: { agents: new AgentsClient({ baseUrl: this.baseUrl }) } };
  }

  async verifyToken<T extends TokenPayload = TokenPayload>(
    token: string,
  ): Promise<VerifyResult<T>> {
    if (!this.jwksCache) {
      this.jwksCache = new JwksCache(this.baseUrl);
    }

    const sdkEnv = this.apiKey.startsWith('akm_test_') ? 'test' : 'live';
    return verifyToken<T>(token, this.jwksCache, this.clockTolerance, sdkEnv);
  }

  async verifyWebhook<T = WebhookEvent>(
    body: string | Buffer,
    headers: Record<string, string | string[] | undefined>,
    options?: { tolerance?: number },
  ): Promise<VerifyResult<WebhookVerifyData<T>>> {
    if (!this.webhookSecret) {
      return { ok: false, error: CONFIG_MISSING_WEBHOOK_SECRET() };
    }

    const rawTolerance = options?.tolerance ?? this.webhookTolerance;
    const tolerance = Math.min(Math.max(0, rawTolerance), MAX_WEBHOOK_TOLERANCE);
    return verifyWebhookImpl<T>(body, headers, this.webhookSecret, tolerance);
  }

  middleware(
    options?: MiddlewareOptions,
  ): (req: MiddlewareRequest, res: MiddlewareResponse, next: NextFunction) => void {
    return createMiddleware((token) => this.verifyToken(token), options, this.environment);
  }

  generatePKCE(): PkceChallenge {
    return generatePKCEImpl();
  }

  generateState(): string {
    return generateStateImpl();
  }

  buildAuthorizeUrl(options: Omit<AuthorizeUrlOptions, 'clientId'> & { clientId?: string }): string {
    const clientId = options.clientId ?? this.clientId;
    if (!clientId) {
      throw new RakomiError(OAUTH_MISSING_CLIENT_ID());
    }
    return buildAuthorizeUrlImpl({
      ...options,
      clientId,
      baseUrl: options.baseUrl ?? this.baseUrl,
    });
  }

  async exchangeCode(
    options: Omit<OAuthExchangeOptions, 'clientId' | 'clientSecret'> & { clientId?: string; clientSecret?: string },
  ): Promise<VerifyResult<OAuthTokenResponse>> {
    return exchangeCodeImpl({
      ...options,
      clientId: options.clientId ?? this.clientId,
      clientSecret: options.clientSecret ?? this.clientSecret,
      baseUrl: options.baseUrl ?? this.baseUrl,
    });
  }

  async refreshToken(
    options: Omit<OAuthRefreshOptions, 'clientId' | 'clientSecret'> & { clientId?: string; clientSecret?: string },
  ): Promise<VerifyResult<OAuthTokenResponse>> {
    return refreshTokenImpl({
      ...options,
      clientId: options.clientId ?? this.clientId,
      clientSecret: options.clientSecret ?? this.clientSecret,
      baseUrl: options.baseUrl ?? this.baseUrl,
    });
  }

  /**
 * RFC 8693 token-exchange resource.
 *
 * Exchange a user's currently-valid access token for a scoped-down agent
 * token. Returns RFC 8693 §2.2.1 response. Throwing variant for ergonomic
 * try/catch flows (typed errors per RFC 6749 §5.2 codes); the underlying
 * Result-based variant is exposed as `tokens.exchangeViaApi(...)`.
 *
 * The SDK client MUST be constructed with `clientId` + `clientSecret`
 * referencing an agent-type OAuth client (server-side only — never embed
 * `clientSecret` in browser/mobile code). Invocations without those credentials
 * throw `TokenExchangeInvalidClientError` synchronously.
 */
  readonly tokens = {
    exchange: async (options: TokenExchangeOptions): Promise<TokenExchangeResponse> => {
      if (!this.clientId || !this.clientSecret) {
        throw new RakomiError(OAUTH_MISSING_CLIENT_ID());
      }
      return exchangeTokenOrThrowImpl(
        { baseUrl: this.baseUrl, clientId: this.clientId, clientSecret: this.clientSecret },
        options,
      );
    },
    exchangeViaApi: async (options: TokenExchangeOptions): Promise<VerifyResult<TokenExchangeResponse>> => {
      if (!this.clientId || !this.clientSecret) {
        return { ok: false, error: OAUTH_MISSING_CLIENT_ID() };
      }
      return exchangeTokenViaApiImpl(
        { baseUrl: this.baseUrl, clientId: this.clientId, clientSecret: this.clientSecret },
        options,
      );
    },
  };

  /**
 * OIDC CIBA Core 1.0 (asynchronous user consent) resource.
 *
 * Three operations:
 * - `initiate(options)` → POST /oauth/bc-authorize.
 * - `poll(authReqId)` → POST /oauth/token grant=ciba.
 * - `awaitDecision(opts)` → poll-loop until decision / abort.
 *
 * The SDK client MUST be constructed with `clientId` + `clientSecret`
 * referencing a confidential or agent-type OAuth client registered with
 * `grantTypes` including `urn:openid:params:grant-type:ciba` and the
 * Pro+ tier flag. Invocations without those credentials reject the
 * Result with `OAUTH_MISSING_CLIENT_ID`.
 */
  readonly ciba = {
    initiate: async (options: CibaInitiateOptions): Promise<VerifyResult<CibaInitiateResponse>> => {
      if (!this.clientId || !this.clientSecret) {
        return { ok: false, error: OAUTH_MISSING_CLIENT_ID() };
      }
      return initiateCibaImpl(
        { baseUrl: this.baseUrl, clientId: this.clientId, clientSecret: this.clientSecret },
        options,
      );
    },
    poll: async (authReqId: string): Promise<VerifyResult<CibaPollResponse>> => {
      if (!this.clientId || !this.clientSecret) {
        return { ok: false, error: OAUTH_MISSING_CLIENT_ID() };
      }
      return pollCibaImpl(
        { baseUrl: this.baseUrl, clientId: this.clientId, clientSecret: this.clientSecret },
        authReqId,
      );
    },
    awaitDecision: async (options: CibaAwaitDecisionOptions): Promise<CibaPollResponse> => {
      if (!this.clientId || !this.clientSecret) {
        throw new RakomiError(OAUTH_MISSING_CLIENT_ID());
      }
      return awaitCibaDecisionImpl(
        { baseUrl: this.baseUrl, clientId: this.clientId, clientSecret: this.clientSecret },
        options,
      );
    },
  };

  /**
 * Create an anonymous user and return its token pair.
 *
 * Call from a trusted backend. Returns a Result (never throws on known API
 * errors); on 403/402/429 the error is mapped to a stable SDK error code.
 */
  async anonymous(
    options: AnonymousSigninOptions = {},
  ): Promise<VerifyResult<AnonymousSigninResult>> {
    return anonymousSignin(
      {
        baseUrl: this.baseUrl,
        apiKey: this.apiKey,
      },
      options,
    );
  }
}
