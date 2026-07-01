/**
 * @rakomi/react — React SDK for Rakomi Auth.
 *
 * Public API surface:
 * - <RakomiProvider> — context provider
 * - useAuth() — primary auth hook
 * - useUser() — user resource hook
 * - useSession() — session resource hook
 * - <SignedIn> / <SignedOut> — conditional rendering
 * - Types: AuthState, AuthError, UserResource, SessionResource, etc.
 *
 * All types are included — no separate @types package required.
 * Zero runtime dependencies beyond React peer dependency.
 *
 * @example
 * import { RakomiProvider, useAuth, SignedIn } from '@rakomi/react';
 */

export { RakomiProvider } from './context.js';

export type { UseAnonymousSigninResult } from './hooks/use-anonymous-signin.js';
export { useAnonymousSignin } from './hooks/use-anonymous-signin.js';
export { useAuth } from './hooks/use-auth.js';
export { useAuthConfig } from './hooks/use-auth-config.js';
export { useBranding } from './hooks/use-branding.js';
export { useFlag } from './hooks/use-flag.js';
export type {
  LinkedMethod,
  LinkedMethods,
  LinkedVia,
  LinkProvider,
  UseLinkedAccountsResult,
} from './hooks/use-linked-accounts.js';
export { useLinkedAccounts } from './hooks/use-linked-accounts.js';
export { useOrganization } from './hooks/use-organization.js';
export { useOrganizationList } from './hooks/use-organization-list.js';
export { useSession } from './hooks/use-session.js';
export { useUser } from './hooks/use-user.js';

export { CustomerPortal, PricingTable, SubscriptionManager } from './components/billing/index.js';
export { Feature } from './components/Feature.js';
export { Protect } from './components/protect.js';
export { SignIn } from './components/sign-in/index.js';
export { SignUp } from './components/sign-up/index.js';
export { SignedIn } from './components/signed-in.js';
export { SignedOut } from './components/signed-out.js';
export { UserButton } from './components/user-button/index.js';
export { UserProfile } from './components/user-profile/index.js';

export { hasPermission, hasRole } from './rbac.js';

export type { Locale, TranslationFn, TranslationKey, Translations } from './i18n/index.js';
export { createTranslator, de, en, es,fr, pl, selectPluralForm } from './i18n/index.js';

export type {
  AnonymousSigninRequest,
  AnonymousSigninResponse,
  AuthConfig,
  AuthError,
  AuthEvent,
  AuthState,
  BrandingConfig,
  HasParams,
  InitialAuthState,
  OAuthTokenResponse,
  OrgContext,
  OrgMembership,
  RakomiProviderProps,
  RegisterResult,
  SdkError,
  SessionInfo,
  SessionResource,
  SignInOptions,
  SignInResult,
  SwitchOrgResult,
  TabSyncMessage,
  TokenPayload,
  TokenResult,
  TokenStorage,
  UserResource,
  VerifyResult,
} from './types.js';

export type { CustomerPortalProps, PricingTableProps, SubscriptionManagerProps } from './components/billing/index.js';
export type { FeatureProps } from './components/Feature.js';
export type { ProtectProps } from './components/protect.js';
export type { SignInProps } from './components/sign-in/index.js';
export type { SignUpProps } from './components/sign-up/index.js';
export type { SignedInProps } from './components/signed-in.js';
export type { SignedOutProps } from './components/signed-out.js';
export type { UserButtonProps } from './components/user-button/index.js';
export type { UserProfileProps } from './components/user-profile/index.js';
export type { UseAuthConfigReturn } from './hooks/use-auth-config.js';
export type { UseBrandingReturn } from './hooks/use-branding.js';
export type { UseFlagOptions, UseFlagReturn, UseFlagUserContext } from './hooks/use-flag.js';
export type { UseOrganizationReturn } from './hooks/use-organization.js';
export type { UseOrganizationListReturn } from './hooks/use-organization-list.js';
export type { UseSessionReturn } from './hooks/use-session.js';
export type { UseUserReturn } from './hooks/use-user.js';
