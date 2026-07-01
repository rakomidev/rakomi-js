# Compliance — `@rakomi/react-native`

Regulatory cross-reference for tenants in EU-regulated industries.

## CRA — Reg. (EU) 2024/2847 (Cyber Resilience Act)

This package is a "product with digital elements" under CRA Annex I. Same posture as `@rakomi/node` and `@rakomi/react`.

| CRA reference | Compliance posture |
|---|---|
| Art. 13 — Vulnerability handling | Documented secure vulnerability-handling process; vulnerability records retained with the technical documentation. Internal fix targets (e.g. 14 days for High severity) are an operational SLA, **not** a statutory deadline. See `SECURITY.md`. |
| Art. 14 — Reporting of actively exploited vulnerabilities & severe incidents | Statutory reporting to the designated authority on the CRA timeline (early warning → notification → final report) and informing impacted users; published advisories via GitHub Security Advisories. See `SECURITY.md`. |
| Annex I — Essential cybersecurity requirements | Secure defaults: fixed asymmetric token-signature verification, PKCE with S256 challenge (RFC 7636), biometric opt-in, ephemeral session, minimal attack surface. |

## GDPR — Reg. (EU) 2016/679

| Article | Posture |
|---|---|
| Art. 25 — Data protection by design | No PII collected client-side beyond what API requires; analytics opt-in via `onEvent` only. |
| Art. 28 — Processor obligations | SDK is a data-processor adjunct; tenant is data controller. DPA covers the relationship. |
| Art. 32 — Security of processing | Pseudonymisation + encryption at rest (Keychain) + access control (biometric opt-in). |

## eIDAS 2 — Reg. (EU) 2024/1183 (EUDI Wallet)

End-of-2026 mandate. The `NativeAuthAdapter` exposes a typed forward-compat slot (`verifiers?: AttestationVerifier[]`) to non-breakingly add EUDI PID verification once the EU Wallet implementing acts publish.

## NIS2 — Dir. (EU) 2022/2555

Tenants in essential / important sectors can attest that their auth-provider meets the NIS2 Art. 21 measures by referencing this SDK's posture in their conformity self-assessment:

- Risk-management measures: cryptographic + access controls documented in `SECURITY.md`.
- Incident handling: statutory reporting of actively exploited vulnerabilities / severe incidents per CRA Art. 14 (early warning, notification, final report); see `SECURITY.md`.
- Supply-chain security: SBOM (CycloneDX) shipped with every release; npm build provenance (SLSA Build L2) attached to every published package.

## DORA — Reg. (EU) 2022/2554

For financial-sector tenants — the SDK's MFA + passkey roadmap satisfies SCA requirements (PSD2 RTS / PSD3-PSR forthcoming).

## Apple App Store / Google Play Data Safety

Tenant fills the privacy nutrition labels. The SDK's data collection (consumer-app perspective):

- **User ID** — for app functionality (sign-in / sign-out lifecycle).
- **No** location, browsing history, advertising data, or third-party shipping by default.

## WCAG 2.2 AA / EAA (Dir. 2019/882)

Mobile accessibility:

- Every interactive element has `accessibilityLabel` + `accessibilityRole` (verified by component snapshot tests).
- Keyboard hints (`textContentType`, `autoComplete`, `keyboardType`) appropriate for OTP / email / password.
- TOTP input uses `oneTimeCode` (iOS auto-fill); Android SMS Retriever is out-of-scope here (deferred).

## OWASP MASVS L1 + Mobile Top 10 (2024)

See `SECURITY.md` for the per-control mapping.

## EU AI Act — Reg. (EU) 2024/1689

This SDK does **NO AI inference**. Negative-scope statement for tenant comfort.
