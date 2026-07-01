/**
 * @rakomi/sdk-core — platform-neutral helpers shared by `@rakomi/react` and `@rakomi/react-native`.
 *
 * Pure helpers live here; platform-coupled I/O
 * is injected via the adapter contracts in `./types/adapters`.
 */

export type {
  CryptoProvider,
  HttpClient,
  HttpClientInit,
  KeyValueGetOptions,
  KeyValueSetOptions,
  KeyValueStore,
} from './types/adapters.js';
export type {
  AuthConfig,
  AuthEvent,
  AuthMachineState,
  BrandingConfig,
  HasParams,
  InitialAuthState,
  OAuthTokenResponse,
  OrgContext,
  OrgMembership,
  RegisterResult,
  SessionInfo,
  SessionResource,
  SignInOptions,
  SignInResult,
  SwitchOrgResult,
  TokenResult,
  UserResource,
} from './types/auth.js';
export type { AuthError } from './types/auth-error.js';
export { getErrorMessage } from './types/auth-error.js';

export type { MachineAction, MachineSnapshot } from './auth-machine.js';
export { INITIAL_SNAPSHOT, isSignedIn, reduce, shouldRefresh } from './auth-machine.js';
export { EventLog } from './event-log.js';
export type { Locale, TranslationFn, TranslationKey, Translations } from './i18n.js';
export { createTranslator, selectPluralForm } from './i18n.js';
export type { JwksCache, JwksCacheOptions, JwksDocument } from './jwks-cache.js';
export { createJwksCache } from './jwks-cache.js';
export { decodeJwtPayload, decodeSession, decodeUser } from './jwt-decode.js';
export { hasPermission, hasRole } from './rbac.js';
export type { StorageKeyPurpose } from './storage-keys.js';
export { deriveTenantStorageKey } from './storage-keys.js';
export { isSafeUrl, type PasswordStrength, scorePassword } from './utils.js';

export type {
  RegisterInput,
  RequestEmailOtpInput,
  RequestMagicLinkInput,
  RequestResult,
  VerifyEmailOtpInput,
  VerifyMagicLinkInput,
  VerifyResult,
} from './auth-flows.js';
export {
  register,
  requestEmailOtp,
  requestMagicLink,
  verifyEmailOtp,
  verifyMagicLink,
} from './auth-flows.js';

export type { BuildAuthorizationUrlInput } from './oauth/authorize.js';
export { buildAuthorizationUrl } from './oauth/authorize.js';
export { networkError, parseOAuthCallbackError, parseTokenEndpointError } from './oauth/errors.js';
export type { VerifyTotpInput, VerifyTotpResult } from './oauth/mfa.js';
export { MfaStepUpRequiredError, MfaStepUpUnavailableError, verifyTotp } from './oauth/mfa.js';
export type { PkceChallenge } from './oauth/pkce.js';
export { base64url, generatePkce } from './oauth/pkce.js';
export { consumeState, type IssuedState, issueState, timingSafeStringEqual } from './oauth/state.js';
export type { ExchangeAuthCodeInput, TokenExchangeResult } from './oauth/token-exchange.js';
export { exchangeAuthCode, refreshAccessToken } from './oauth/token-exchange.js';
