# @rakomi/sdk-core

Runtime-agnostic core for the [Rakomi](https://rakomi.com) JS-family SDKs — EU-native
auth-as-a-service.

**Intended purpose & user:** the shared foundation consumed by `@rakomi/react` and
`@rakomi/react-native`. It carries the runtime-independent auth primitives so the framework SDKs
stay thin and stay in lockstep. Most application developers depend on it transitively, not directly.

- **1 runtime dependency** — only [`jose`](https://github.com/panva/jose) for JWKS verification.
- **ESM-first** with CJS support; fully typed public API.
- No DOM and no React — pure logic (auth state machine, JWKS cache, JWT decode, OAuth PKCE/authorize,
  RBAC helpers, i18n translator, tenant storage-key derivation).

## Install

```bash
pnpm add @rakomi/sdk-core
```

## What's included

- **Auth state machine** — `reduce`, `INITIAL_SNAPSHOT`, `isSignedIn`, `shouldRefresh`.
- **JWKS cache** — `createJwksCache` (host-pinned signing-key verification).
- **JWT decode** — `decodeJwtPayload`, `decodeSession`, `decodeUser`.
- **OAuth** — `buildAuthorizationUrl`, PKCE helpers, typed OAuth error mapping.
- **RBAC** — `hasPermission`, `hasRole`.
- **i18n** — `createTranslator`, plural selection.
- **Utilities** — `isSafeUrl`, `scorePassword`, `deriveTenantStorageKey`.

## Secure defaults

Verification is asymmetric and the algorithm is fixed by policy (never read from the token header);
issuer and audience are enforced. See the
[Secure defaults](https://docs.rakomi.dev/sdk/secure-defaults/) guide.

## Documentation

[docs.rakomi.dev](https://docs.rakomi.dev/sdk/)

## Security & support

- Vulnerability reporting and the coordinated-disclosure policy: [`SECURITY.md`](./SECURITY.md).
- Dated support windows (CRA Art. 13(8)): [SDK Support & Lifecycle](https://rakomi.com/sdk-support).

## License

See [`LICENSE`](./LICENSE).
