# Contributing to rakomi-js

Thanks for your interest in the Rakomi JavaScript / TypeScript SDKs.

## How this repository works

This repository is a **published release mirror**: each release is a self-contained, clean-room snapshot of
the exact SDK source the corresponding npm packages were built from, so the npm build-provenance attestation
resolves to readable, inspectable code (see [VERIFY.md](./VERIFY.md)). Releases are immutable, per-package
git tags (`sdk/v*`, `sdk-core/v*`, `react/v*`, `react-native/v*`); the commit graph is intentionally a
sequence of independent snapshot commits, not a linear development history.

## Reporting issues

- **Bugs / feature requests:** open an issue at <https://github.com/rakomidev/rakomi-js/issues>.
- **Security vulnerabilities:** do NOT open a public issue — use private vulnerability reporting (Security ▸
  Report a vulnerability) or the contact in [SECURITY.md](./SECURITY.md).

## Code contributions

Because each release is a clean-room snapshot, pull requests cannot be merged into this mirror directly. The
most effective way to contribute a code change is to **open an issue describing it** (ideally with a minimal
repro or a patch) — accepted changes are incorporated upstream and ship in the next release, with credit.

## Code of conduct

Participation is governed by our [Code of Conduct](./CODE_OF_CONDUCT.md).
