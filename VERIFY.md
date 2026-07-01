# Verify Rakomi SDK releases yourself

Every `@rakomi/*` package on npm is published with **build provenance** (SLSA Build L2) from this public
repository via OpenID Connect trusted publishing — no long-lived publish token exists anywhere. You do not
have to take our word for any of it. The commands below let an independent third party confirm, from
outside our CI, that the bytes you install came from the source you can read here.

## What provenance proves (and what it does not)

**It proves:** the published tarball was built and published by **this** workflow in **this** public
repository (`rakomidev/rakomi-js`), and the bytes you download are exactly the bytes that were attested —
cryptographically bound by a SHA-512 digest and anchored in the public Sigstore/Rekor transparency log.

**It does not claim** a bit-for-bit reproducible build against any private canonical source: the packages
inline their shared internals at build time, and the readable source in this repository is the **real,
inspectable** source those bytes were produced from. The honesty boundary is therefore precise —
*provenance + signatures + a public `npm pack` you can re-run*, not "reproducible against a hidden oracle".
We deliberately do not over-claim more than the signatures substantiate.

## 1. Verify the published signatures and provenance

```sh
# Confirms registry signatures AND provenance attestations for the installed tree.
npm install @rakomi/sdk-core
npm audit signatures
```

```sh
# Verify the provenance attestation for a specific published version directly:
gh attestation verify --repo rakomidev/rakomi-js \
  "$(npm pack @rakomi/sdk-core@latest --silent)"
```

## 2. Confirm the published bytes match this source

```sh
# 1. Note the provenance subject digest for the version (sha512:...) from `npm view`:
npm view @rakomi/sdk-core@latest dist.integrity

# 2. Clone THIS repo at the matching per-package release tag and pack it yourself.
#    (This is a pnpm workspace — the same toolchain the release pipeline uses; corepack
#    pins pnpm from package.json `packageManager`.)
git clone https://github.com/rakomidev/rakomi-js
cd rakomi-js
git checkout sdk-core/v<version>          # immutable per-package tag — never a moving branch
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @rakomi/sdk-core pack

# 3. The SHA-512 of your locally-packed tarball equals the published provenance subject digest.
```

## 3. Cross-check the clean-room manifest

The repository root carries a `CLEAN-ROOM-MANIFEST.json` that records, for each release, the exact
allow-listed source set (SHA-256 per file), the pinned build toolchain, and the bounded set of inlined
symbols. It is the affirmative complement to our published deny-list: *here is precisely what shipped*. The
manifest SHA-256-pins the source files the published packages are built from — so the bytes you read here,
and re-pack in step 2, are the bytes those releases were produced from. (The manifest file itself is not in
any package's `files[]`, so it is not part of a tarball or a provenance subject; its value is the per-file
SHA-256 pinning of the source, cross-checkable against the source you can read.)

## Per-package release tags

Releases are immutable, per-package tags (`sdk/v*`, `sdk-core/v*`, `react/v*`, `react-native/v*`). Version
history lives in the npm version timeline and each package `CHANGELOG.md`, not in git ancestry — each
release is a clean-room snapshot commit, so a zero-parent commit graph is expected, not a sign of tampering.

## Report a vulnerability

Use this repository's **private vulnerability reporting** (Security ▸ Report a vulnerability) or the contact
in `SECURITY.md`. Fixes are published as a new version and surfaced as a GitHub Security Advisory referencing
the fixed version tag.
