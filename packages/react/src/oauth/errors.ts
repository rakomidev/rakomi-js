/**
 * OAuth error factories — re-export from `@rakomi/sdk-core`.
 * Single source of truth shared across the SDK packages. Behavior unchanged
 * for callers; the implementation lives in the platform-neutral core.
 */
export { networkError, parseOAuthCallbackError, parseTokenEndpointError } from '@rakomi/sdk-core';
