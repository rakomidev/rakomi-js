/**
 * @rakomi/react-native — React Native / Expo SDK for Rakomi Auth.
 *
 * API parity superset of `@rakomi/react`. Native adapter contract injects platform-coupled I/O;
 * pure helpers come from `@rakomi/sdk-core`. RFC 8252 OAuth via system browser only — no WebView.
 */

export type { RakomiProviderProps } from './context.js';
export { RakomiProvider } from './context.js';

export type {
  AuthState,
  LinkedMethod,
  LinkedMethods,
  LinkedVia,
  LinkProvider,
  UseAnonymousSigninResult,
  UseAuthConfigReturn,
  UseBaasPlansReturn,
  UseBaasSubscriptionReturn,
  UseBrandingReturn,
  UseFlagOptions,
  UseFlagReturn,
  UseLinkedAccountsResult,
  UseOrganizationListReturn,
  UseOrganizationReturn,
  UseSessionReturn,
  UseUserReturn,
} from './hooks/index.js';
export {
  useAnonymousSignin,
  useAuth,
  useAuthConfig,
  useBaasPlans,
  useBaasSubscription,
  useBranding,
  useFlag,
  useLinkedAccounts,
  useOrganization,
  useOrganizationList,
  useSession,
  useTranslation,
  useUser,
} from './hooks/index.js';

export type { FeatureProps, ProtectProps, SignedInProps, SignedOutProps } from './components/conditional.js';
export { Feature, Protect, SignedIn, SignedOut } from './components/conditional.js';
export type { SignInProps } from './components/sign-in.js';
export { SignIn } from './components/sign-in.js';
export type { SignUpProps } from './components/sign-up.js';
export { SignUp } from './components/sign-up.js';
export type { UserButtonProps } from './components/user-button.js';
export { UserButton } from './components/user-button.js';
export type { UserProfileProps } from './components/user-profile.js';
export { UserProfile } from './components/user-profile.js';

export {
  type AppLifecycle,
  type AppStateValue,
  type AttestationVerifier,
  type BackgroundTask,
  type BiometricGate,
  type BiometricResult,
  type BrowserAuthSessionOptions,
  type BrowserAuthSessionResult,
  type ConnectivityProvider,
  createDefaultExpoAdapter,
  type CreateDefaultExpoAdapterOptions,
  createNativeDpopProver,
  type CreateNativeDpopProverOptions,
  type DeepLinkProvider,
  type DpopProofInput,
  type DpopProver,
  type NativeAuthAdapter,
  type NativeDpopModuleSpec,
  type ParClient,
  type SystemBrowser,
  type TokenCache,
} from './native/index.js';

export type { DpopRefreshError, DpopRefreshErrorClass, DpopRefreshResult } from './internal/dpop-refresh.js';
export type { CreateDpopSessionOptions, DpopDowngradeInfo } from './internal/dpop-session.js';
export { createDpopSession, DpopSession } from './internal/dpop-session.js';

export type { CreateRnHttpClientOptions } from './internal/http-client.js';
export { createRnHttpClient } from './internal/http-client.js';

export type {
  PublisherEventType,
  PublisherWebhookEvent,
  PublisherWebhookEventType,
  PublisherWebhookVerifyData,
  WebhookVerifyErrorClass,
  WebhookVerifyResult,
} from './internal/webhook-verify.js';
export {
  DEFAULT_WEBHOOK_TOLERANCE,
  MAX_WEBHOOK_TOLERANCE,
  verifyPublisherWebhook,
  verifyWebhook,
} from './internal/webhook-verify.js';

export type { SocialSignInOutcome, StartSocialSignInInput } from './oauth/social-auth.js';
export { startSocialSignIn } from './oauth/social-auth.js';

export { useSubmitOAuthTokens } from './hooks/use-submit-oauth-tokens.js';

export type { UseEmailOtpResult, UseMagicLinkResult, UseMfaResult, UseRegisterResult } from './hooks/use-auth-flows.js';
export { useEmailOtp, useMagicLink, useMfa, useRegister } from './hooks/use-auth-flows.js';

export type {
  AuthError,
  AuthEvent,
  AuthMachineState,
  CryptoProvider,
  HasParams,
  HttpClient,
  KeyValueStore,
  Locale,
  PkceChallenge,
  RegisterResult,
  SessionResource,
  SignInOptions,
  SignInResult,
  SwitchOrgResult,
  TokenResult,
  Translations,
  UserResource,
} from '@rakomi/sdk-core';
export {
  base64url,
  createTranslator,
  decodeJwtPayload,
  decodeSession,
  decodeUser,
  generatePkce,
  getErrorMessage,
  hasPermission,
  hasRole,
  isSafeUrl,
  MfaStepUpRequiredError,
  MfaStepUpUnavailableError,
  networkError,
  parseOAuthCallbackError,
  parseTokenEndpointError,
  scorePassword,
  selectPluralForm,
} from '@rakomi/sdk-core';
