# @rakomi/node

Server-side Node.js SDK for [Rakomi](https://rakomi.com) — EU-native auth-as-a-service.

**Intended purpose & user:** for backend developers verifying Rakomi access tokens and webhook
signatures in a trusted Node.js runtime.

- **1 runtime dependency** — only [`jose`](https://github.com/panva/jose) for JWT/JWKS operations.
- **ESM-first** — ships as ES modules; CJS supported via Node.js `require(esm)`.
- **Result pattern** — `verifyToken()` / `verifyWebhook()` never throw; they return
  `{ ok: true, data }` or `{ ok: false, error }`.
- **Type-safe** — full TypeScript types with generic payload support.

## Ask your agent

Add the Rakomi MCP server to your coding agent, then ask it directly:

```sh
claude mcp add --transport http rakomi https://mcp.rakomi.com/mcp
```

"List the AI agents connected to my Rakomi tenant."

## Install

```bash
pnpm add @rakomi/node
```

Requires **Node.js 20+** (global `fetch` and Web Crypto — no polyfills, no runtime detection).

## Quick start

```typescript
import { RakomiClient } from '@rakomi/node';

const rakomi = new RakomiClient({
  apiKey: 'akm_live_xxx', // akm_test_* in development
});

const result = await rakomi.verifyToken(token);
if (result.ok) {
  console.log('User ID:', result.data.userId);
} else {
  console.error('Error:', result.error.code);
}
```

API keys must start with `akm_live_` (production) or `akm_test_` (testing).

An `akm_test_` key acts on the test environment's data only; a record of the live environment answers `404`. The
account compliance endpoints (DPA, audit package, breach assessments, DPIAs and the like) need a live key; a test key
gets `404 auth/environment_not_permitted`. A user's data export works with a key of the user's environment.

## Secure defaults

Token signatures are verified with a fixed asymmetric algorithm (never read from the token header),
the signing-key set is fetched only from the pinned issuer host, and issuer/audience/expiry are
enforced. See the [Secure defaults](https://docs.rakomi.dev/sdk/secure-defaults/) guide.

## Background agents

An agent that must keep working after its human has signed out asks for a background-agent grant
once, then renews its own access token. The grant exists only for a confidential agent client, in
a tenant whose policy allows it, on a plan that includes it.

```typescript
// 1. Ask the human: adds `offline_access` to the scope and sends `prompt=consent`.
const url = rakomi.buildAuthorizeUrl({ redirectUri, codeChallenge, state, offlineAccess: true });

// 2. Renew, server-side, with the agent client's own credentials.
const renewed = await rakomi.refreshAgentToken({ refreshToken: stored });
if (renewed.ok) {
  await save(renewed.data.refreshToken); // single-use: store the successor FIRST
  use(renewed.data.accessToken);
} else if (renewed.error.code === 'auth/invalid_refresh_token') {
  // The grant has ended; ask the human again.
}
```

The refresh token is single-use. Presenting a consumed one ends the grant and every session of the
human. See [Background agents](https://docs.rakomi.dev/guides/background-agents/).

## Documentation

- [SDK reference](https://docs.rakomi.dev/sdk/) · [Quickstart](https://docs.rakomi.dev/getting-started/quickstart-sdk/)
- [Error codes](https://docs.rakomi.dev/sdk/errors/)

## Security & support

- Vulnerability reporting and the coordinated-disclosure policy: [`SECURITY.md`](./SECURITY.md).
- Dated support windows (CRA Art. 13(8)): [SDK Support & Lifecycle](https://rakomi.com/sdk-support).

## License

See [`LICENSE`](./LICENSE).
