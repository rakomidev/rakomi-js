# Compliance — `@rakomi/react-native`

Regulatory cross-reference for tenants in EU-regulated industries.

## CRA — Reg. (EU) 2024/2847 (Cyber Resilience Act)

This package is a "product with digital elements" under CRA Art. 3(1). Same posture as `@rakomi/node` and `@rakomi/react`.

| CRA reference | Compliance posture |
|---|---|
| Art. 13 — Vulnerability handling | Documented secure vulnerability-handling process; vulnerability records retained with the technical documentation. Internal fix targets (e.g. 14 days for High severity) are an operational SLA, **not** a statutory deadline. See `SECURITY.md`. |
| Art. 14 — Reporting of actively exploited vulnerabilities & severe incidents | Statutory reporting to the designated authority on the CRA timeline (early warning → notification → final report) and informing impacted users; published advisories via GitHub Security Advisories. See `SECURITY.md`. |
| Annex I — Essential cybersecurity requirements | Secure defaults: fixed asymmetric token-signature verification, PKCE with S256 challenge (RFC 7636), biometric opt-in, ephemeral session, minimal attack surface. **Passkeys:** no passkey library is bundled or depended on by **this package** — the OS ceremony is reached through a module the host supplies. Read that precisely: it removes third-party ceremony code from *our* dependency tree and therefore from *our* SBOM; the module you wire **is** on the credential path and is **your** supply-chain surface, so account for it in yours. The bridge itself carries no bearer token, emits nothing to telemetry or the console, and an unwired adapter fails closed (`PASSKEY_NOT_SUPPORTED`) rather than falling back to a different ceremony. Proving test: `test/passkey-native-adapter.test.ts` (`@asserts CTRL-CRA-ANNEXI-SECURE-DEFAULT`). |

## GDPR — Reg. (EU) 2016/679

| Article | Posture |
|---|---|
| Art. 25 — Data protection by design | No PII collected client-side beyond what API requires; analytics opt-in via `onEvent` only. **Passkeys — sign-in:** identified sign-in takes an opaque, server-issued user handle, never an email or a username. **Passkeys — registration (state this plainly):** the registration options the server issues carry the account's `user.name` / `user.displayName`, which today is the user's **email address**. It crosses the bridge to the host-supplied module and is passed to the platform credential provider, which stores it with the credential and may **sync it to the user's platform account** (iCloud Keychain / Google Password Manager). This is inherent to WebAuthn — the value is what the user is shown when they pick a passkey — not a choice this SDK makes, and it is disclosed here rather than glossed. The SDK adds no identifier of its own. **Errors:** the credential-envelope validator names the failing FIELD, never its VALUE; error messages relayed from the server or from the host's own callbacks are passed through verbatim and are the tenant's surface to control. |
| Art. 28 — Processor obligations | SDK is a data-processor adjunct; tenant is data controller. DPA covers the relationship. |
| Art. 32 — Security of processing | Pseudonymisation + encryption at rest (Keychain) + access control (biometric opt-in). **Passkeys — key material:** the private key is created and held by the platform credential provider; it never enters SDK memory and the SDK holds no passkey material at rest. Proving test: `test/use-passkeys.test.tsx` (`@asserts CTRL-GDPR-32-NO-SECRET-TO-ADAPTER` — no access token, step-up token or bearer secret reaches the ceremony adapter). |
| Art. 32 — Security of processing (session integrity) | A completed ceremony whose session was **not** actually stored is reported as a failure, never as a success — the SDK re-reads the token runtime and matches the session identity before it reports a sign-in. Proving test: `test/use-passkeys.test.tsx` (the session-confirmation polarities). |
| Art. 32 — Security of processing (re-authentication gate) | Management actions (list / rename / delete) are re-authentication-gated. **The gate is enforced by the API, not by this SDK** — the SDK transmits the step-up token it is given and does not itself decide whether one is sufficient. Stated here because an SDK compliance doc must not claim credit for a server-side control. |
| Art. 9 — Special categories (negative scope) | **No biometric data is processed by this SDK.** A fingerprint or face is consumed by the operating system to unlock the authenticator; the SDK receives only the resulting assertion. It never reads, stores, transmits or infers a biometric template, so Art. 9's special-category regime is not engaged by anything this library does. (Whether YOUR app processes biometrics for other purposes is your assessment.) |

## eIDAS 2 — Reg. (EU) 2024/1183 (EUDI Wallet)

End-of-2026 mandate. The `NativeAuthAdapter` exposes a typed forward-compat slot (`verifiers?: AttestationVerifier[]`) to non-breakingly add EUDI PID verification once the EU Wallet implementing acts publish.

## NIS2 — Dir. (EU) 2022/2555

NIS2 Art. 21 measures are obligations on the **entity**, and no supplier's posture discharges them. What
this SDK offers is *input* to your own risk assessment, not an attestation:

- Risk-management measures: cryptographic + access controls documented in `SECURITY.md`.
- Incident handling: statutory reporting of actively exploited vulnerabilities / severe incidents per CRA Art. 14 (early warning, notification, final report); see `SECURITY.md`.
- Supply-chain security: SBOM (CycloneDX) shipped with every release; npm build provenance (SLSA Build L2) attached to every published package.

## DORA — Reg. (EU) 2022/2554

For financial-sector tenants, DORA governs ICT risk management (Art. 5–15) and ICT third-party risk
(Art. 28–30). What this SDK offers as *input* to those obligations, as one ICT component you consume:

- A CycloneDX SBOM and npm build provenance (SLSA Build L2) with every release — supporting your ICT
  risk-management and supply-chain analysis. (Your Art. 28(3) register of information records the
  **contractual arrangement** for the Rakomi service, not this library artefact.)
- Vulnerability handling per CRA Art. 13 + Annex I Part II, and statutory reporting per CRA Art. 14;
  see `SECURITY.md`.

## Strong Customer Authentication (PSD2 / RTS 2018/389)

**This SDK makes no SCA claim and no assurance-level (AAL / eIDAS LoA) claim.** SCA is a property of a
payment flow, assessed by the payment service provider against its own deployment; a library cannot
satisfy it, and nothing in this document should be quoted as if it could. Two things are worth stating
because they are the parts a PSP most often assumes wrongly:

- **Dynamic linking (RTS Art. 5) is NOT provided.** This SDK authenticates a *user*, not a
  *transaction*: it accepts no amount and no payee, and binds neither into the signed challenge. A
  payment initiation requiring dynamic linking cannot be built on this SDK's passkey flow alone.
- **A platform passkey is not necessarily device-bound.** On both iOS and Android a passkey is, by
  default, **synced** through the platform account (iCloud Keychain / Google Password Manager), and the
  SDK cannot tell a synced credential from a device-bound one — the WebAuthn signals that would hint at
  it are opaque relays we neither interpret nor vouch for. Any element analysis under RTS Art. 7 or Art. 9
  (including whether the elements are independent on a multi-purpose device, per Art. 9(2)–(3)) is
  therefore the PSP's assessment, on evidence this SDK does not supply.

PSD3/PSR are proposals and, as at 2026-07, are not in force; nothing here anticipates their final text.

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
