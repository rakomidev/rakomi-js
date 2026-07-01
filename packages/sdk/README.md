# @rakomi/node

Server-side Node.js SDK for [Rakomi](https://rakomi.com) — EU-native auth-as-a-service.

**Intended purpose & user:** for backend developers verifying Rakomi access tokens and webhook
signatures in a trusted Node.js runtime.

- **1 runtime dependency** — only [`jose`](https://github.com/panva/jose) for JWT/JWKS operations.
- **ESM-first** — ships as ES modules; CJS supported via Node.js `require(esm)`.
- **Result pattern** — `verifyToken()` / `verifyWebhook()` never throw; they return
  `{ ok: true, data }` or `{ ok: false, error }`.
- **Type-safe** — full TypeScript types with generic payload support.

## Install

```bash
pnpm add @rakomi/node
```

Requires **Node.js 22+**.

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

## Secure defaults

Token signatures are verified with a fixed asymmetric algorithm (never read from the token header),
the signing-key set is fetched only from the pinned issuer host, and issuer/audience/expiry are
enforced. See the [Secure defaults](https://docs.rakomi.dev/sdk/secure-defaults/) guide.

## Documentation

- [SDK reference](https://docs.rakomi.dev/sdk/) · [Quickstart](https://docs.rakomi.dev/getting-started/quickstart-sdk/)
- [Error codes](https://docs.rakomi.dev/sdk/errors/)

## Security & support

- Vulnerability reporting and the coordinated-disclosure policy: [`SECURITY.md`](./SECURITY.md).
- Dated support windows (CRA Art. 13(8)): [SDK Support & Lifecycle](https://rakomi.com/sdk-support).

## License

See [`LICENSE`](./LICENSE).
