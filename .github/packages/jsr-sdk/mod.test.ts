// Run: node --test .github/packages/jsr-sdk/mod.test.ts (Node.js 22.18+, type stripping). Not published.
import assert from "node:assert/strict";
import { test } from "node:test";

import { discover, RakomiDiscoveryError } from "./mod.ts";

const issuer = "https://auth.example.com";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function serve(routes: Record<string, () => Response>, seen: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    const r = routes[url];
    return r ? r() : new Response("not found", { status: 404 });
  }) as typeof fetch;
}

const healthy = (iss = issuer, jwksUri = `${issuer}/.well-known/jwks.json`) => ({
  [`${issuer}/.well-known/openid-configuration`]: () => json({ issuer: iss, jwks_uri: jwksUri, token_endpoint: `${issuer}/oauth/token` }),
  [jwksUri]: () => json({ keys: [{ kty: "EC", kid: "k1" }] }),
});

const refused = (p: Promise<unknown>) => assert.rejects(p, RakomiDiscoveryError);

test("returns the metadata and the key set of the issuer", async () => {
  const seen: string[] = [];
  const d = await discover(issuer, { fetch: serve(healthy(), seen) });
  assert.equal(d.issuer, issuer);
  assert.equal(d.metadata.token_endpoint, `${issuer}/oauth/token`);
  assert.equal(d.jwks.keys.length, 1);
  assert.deepEqual(seen, [`${issuer}/.well-known/openid-configuration`, `${issuer}/.well-known/jwks.json`]);
});

test("refuses metadata that names another issuer", async () => {
  await refused(discover(issuer, { fetch: serve(healthy("https://evil.example")) }));
  await refused(discover(`${issuer}/`, { fetch: serve(healthy()) }));
});

test("refuses a non-https issuer, credentials, a query or a fragment before any request", async () => {
  const seen: string[] = [];
  for (const bad of ["http://auth.example.com", `${issuer}?x=1`, `${issuer}#f`, `${issuer}?`, "https://u:p@auth.example.com", "not a url"]) {
    await refused(discover(bad, { fetch: serve(healthy(), seen) }));
  }
  assert.deepEqual(seen, []);
});

test("refuses an http jwks_uri, a redirect, a non-JSON body and a key set without keys", async () => {
  await refused(discover(issuer, { fetch: serve(healthy(issuer, "http://auth.example.com/jwks.json")) }));
  await refused(discover(issuer, {
    fetch: serve({ [`${issuer}/.well-known/openid-configuration`]: () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }) }),
  }));
  await refused(discover(issuer, { fetch: serve({ [`${issuer}/.well-known/openid-configuration`]: () => new Response("<html>") }) }));
  const noKeys = { ...healthy(), [`${issuer}/.well-known/jwks.json`]: () => json({ nokeys: true }) };
  await refused(discover(issuer, { fetch: serve(noKeys) }));
});

test("asks for no redirect following and a JSON answer", async () => {
  let init: RequestInit | undefined;
  const f = (async (_: RequestInfo | URL, i?: RequestInit) => {
    init = i;
    return new Response("x", { status: 500 });
  }) as typeof fetch;
  await refused(discover(issuer, { fetch: f }));
  assert.equal(init?.redirect, "manual");
  assert.ok(init?.signal instanceof AbortSignal);
});

test("a transport failure is a RakomiDiscoveryError", async () => {
  await refused(discover(issuer, { fetch: (async () => { throw new TypeError("boom"); }) as typeof fetch }));
});
