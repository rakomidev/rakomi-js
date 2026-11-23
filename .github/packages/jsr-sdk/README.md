# @rakomi/sdk

OpenID Connect discovery for a [Rakomi](https://rakomi.com) issuer, with no
dependencies: it uses only the web-standard `fetch`, `URL` and `AbortSignal`
(or the `fetch` you pass in). Its tests run on Node.js 22.

The full server SDK for Node.js is [`@rakomi/node`](https://www.npmjs.com/package/@rakomi/node)
on npm.

```ts
import { discover } from "jsr:@rakomi/sdk";

const d = await discover("https://auth.example.com");
console.log(d.metadata.token_endpoint, d.jwks.keys.length);
```

`discover` fetches `<issuer>/.well-known/openid-configuration` and then the
`jwks_uri` it names. It rejects with a `RakomiDiscoveryError`:

- an issuer or `jwks_uri` that is not `https` (or carries credentials, a query
  or a fragment);
- a redirect, a non-200 answer or a body that is not a JSON object;
- metadata whose `issuer` is not exactly the requested issuer (OpenID Connect
  Discovery 1.0 §4.3);
- a key set without a `keys` array.

It does not cache and does not verify tokens.

## License

MIT, see [LICENSE](LICENSE).
