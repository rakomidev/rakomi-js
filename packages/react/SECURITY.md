# Security Policy

## Supported Versions

This policy covers the four JS-family SDK packages: `@rakomi/node`, `@rakomi/sdk-core`,
`@rakomi/react`, and `@rakomi/react-native`.

While these packages remain pre-1.0 (`0.x`), they carry **no stability or support guarantee**
(SemVer 2.0.0 §4); the latest `0.x` line receives security updates on a best-effort basis.

From version **1.0** onward, Rakomi maintains the current (N) and previous (N-1) MAJOR in parallel, with N-1 receiving
security-only fixes. The CRA support period for each MAJOR is determined in accordance with
**CRA Art. 13(8)** — at least five years, or the product's expected use time where shorter. The authoritative, machine-readable support windows are published at
[`https://rakomi.com/.well-known/sdk-support.json`](https://rakomi.com/.well-known/sdk-support.json)
and rendered for humans on the [SDK Support & Lifecycle page](https://rakomi.com/sdk-support). This
document points at that single source rather than re-typing dated rows.

Vulnerabilities in peer dependencies (e.g., React) are out of Rakomi's direct scope, but Rakomi will update minimum peer dependency versions when a peer dependency has a known critical CVE affecting SDK users.

## Reporting a Vulnerability

**Please do NOT open a public GitHub issue for security vulnerabilities.**

We support two reporting channels:

1. **Email:** security@rakomi.com (preferred for initial contact)
2. **GitHub Private Vulnerability Reporting:** [Submit via GitHub Security](https://github.com/rakomidev/rakomi-js/security/advisories/new) — each report automatically receives a GHSA tracking identifier (GHSA-xxxx-xxxx-xxxx).

For encrypted communication, a PGP public key is available at:
`https://rakomi.com/rakomi-security-pgp-key.asc`

Include the key fingerprint from this file (section 14) for out-of-band verification when sending encrypted reports.

## Response Targets

We strive to meet these response targets. Actual response times may vary based on issue complexity and team availability.

| Severity | First Response | Fix Target | Disclosure |
|----------|---------------|------------|------------|
| Critical (actively exploited) | without undue delay (target: 24h) | 72h patch/mitigation | Designated EU authority notified within 24h (CRA Art. 14) |
| High | without undue delay (target: 48h) | 14 days | Coordinated after fix |
| Medium | 5 business days | 90 days | Coordinated after fix |
| Low | 5 business days | Next release cycle | Changelog note |

Severity is assessed using industry-standard vulnerability scoring criteria.

Rakomi is maintained by a small team. During periods of reduced availability, the auto-reply from security@rakomi.com will confirm receipt and provide the PGP key. For actively exploited vulnerabilities, we will respond as quickly as humanly possible.

## Coordinated Vulnerability Disclosure (CVD) Policy

We follow a coordinated disclosure model with a **90-day embargo** period from the date of acknowledgment. During this time:

- Rakomi will work to develop and release a fix
- We will keep the reporter updated on progress at least every 7 business days for Critical/High severity issues
- We will notify the reporter when a fix is released
- After 90 days, we will publish a security advisory regardless of fix status

We may request an extension if the fix requires significant infrastructure changes, and we will coordinate with the reporter before any deadline extension.

## Safe Harbor

We will not pursue legal action against researchers who follow this disclosure policy and act in good faith. We consider security research conducted in accordance with this policy to be:
- Conducted lawfully and in good faith under applicable EU law
- Not subject to legal action by CRE8EVE Sp. z o.o.

Safe harbor **does not extend to**:
- Accessing or modifying other users' data
- Performing denial of service attacks
- Social engineering employees or users
- Exfiltrating data beyond what is necessary to demonstrate the vulnerability
- Any activity that violates applicable law

## Scope

**In scope:**
- `@rakomi/node`, `@rakomi/sdk-core`, `@rakomi/react`, and `@rakomi/react-native` SDK source code and published npm packages
- Security properties of API interactions initiated by the SDKs (request signing, token verification, credential handling)
- Authentication flow logic within the SDKs

**Out of scope:**
- Social engineering attacks against Rakomi employees or users
- Denial of service attacks
- Physical security
- Vulnerabilities in third-party services used by Rakomi's backend
- Vulnerabilities in peer dependencies (e.g., React) — reported to the relevant maintainer, but Rakomi will update minimum peer dependency versions when a peer dependency has a known critical CVE affecting SDK users

This policy applies to the official `@rakomi/node`, `@rakomi/sdk-core`, `@rakomi/react`, and `@rakomi/react-native` packages distributed via npmjs.com. Forks and derivatives are maintained by their respective authors. Customers in regulated sectors (healthcare, finance) may have additional notification obligations beyond this general policy — contact security@rakomi.com for sector-specific compliance documentation.

## EU Authority Reporting

It is our **policy** to report actively exploited vulnerabilities and severe security incidents
having an impact on the security of our products to the relevant EU authority in accordance with
**CRA Art. 14**, on the statutory timeline: an early warning, followed by a fuller notification, and
a final report.

We report to the national coordinator CSIRT designated for our Member State of main establishment
(Poland), which is our live reporting channel today; onboarding to the EU single reporting platform
is in progress, and that platform is the documented onward path as it becomes available to
manufacturers.

## Security Update Notifications

Consumers of Rakomi SDKs can receive security update notifications through:
- **GitHub Security Advisories** on this repository (subscribe via GitHub "Watch" → "Security alerts")
- **npm audit:** `npm audit` or `pnpm audit` will flag known vulnerabilities in installed versions

In accordance with CRA Art. 14(8), after becoming aware of an actively exploited vulnerability or a severe incident having an impact on the security of our products, we will inform impacted users (and, where appropriate, all users) — together with any available risk-mitigation or corrective measures — through the above channels.

## Manufacturer Identification

**Legal entity:** CRE8EVE Sp. z o.o.
**Registered address:** Tulipanowa 4, 72-003 Dobra, Poland (EU)
**Contact:** security@rakomi.com (role-based — no personal mailbox or phone is published)
**Products covered:** `@rakomi/node`, `@rakomi/sdk-core`, `@rakomi/react`, `@rakomi/react-native` (published on npmjs.com)

The manufacturer is itself EU-established (Poland), so no CRA Art. 18 Authorised Representative is required (Art. 18 applies to manufacturers established outside the Union). CRA conformity assessment (Art. 32): these are Class I important products (Annex III). The internal-control procedure (Annex VIII, Module A — manufacturer self-assessment, no notified-body involvement) is available for a Class I product **only where harmonised standards, common specifications, or a European cybersecurity certification scheme at assurance level at least 'substantial' are applied in full** (Art. 32(2)); otherwise a third-party route — EU-type examination plus conformity to type (modules B+C), or full quality assurance (module H) — is required. The applicable route will be confirmed against the harmonised standards in force at the CRA application date. The EU Declaration of Conformity and CE marking attach at the CRA application date (Dec 2027) and are not yet issued. See the full manufacturer record at https://docs.rakomi.dev/compliance/manufacturer/.

## Export Control / Cryptography Notice

The four `@rakomi/*` SDK packages incorporate and invoke cryptography — they verify asymmetric
digital signatures (JWT/token verification), compare key material in constant time, and rely on the
host platform's TLS for transport security. They are distributed as **publicly available, mass-market
software** with cryptographic functionality the end user cannot readily modify.

- **EU — Regulation (EU) 2021/821 (Dual-Use):** the SDKs qualify for the **mass-market** treatment
  under the Cryptography Note (Note 3) to Category 5, Part 2 of Annex I — generally available to the
  public, sold without restriction, and not designed for the user to alter the cryptographic
  functionality. No export authorisation is required for their distribution within or from the EU.
- **US — Export Administration Regulations (EAR):** the cryptographic functionality is classifiable
  under **ECCN 5D002**. As **publicly available** open-source software the source code is **not
  subject to the EAR** (15 CFR §734.7(a)), and the corresponding object code is distributed under the
  mass-market provisions. The one-time email notification of the public source-code URL to the U.S.
  BIS and NSA is filed at first public release (15 CFR §742.15(b)).

This notice is provided for transparency and is **not legal advice**. Downstream redistributors are
responsible for their own export, import, and use obligations in their jurisdiction.

## Post-Market Surveillance

Rakomi monitors SDK health after release through:
- Automated dependency vulnerability scanning (npm audit, Dependabot)
- Runtime error patterns derived from API logs (SDK version reported in User-Agent header)
- Periodic security review of SDK code per the internal security review process

This constitutes the "effective and regular tests and reviews of the security of the product with digital elements" required under CRA Annex I, Part II, point (3). The coordinated-vulnerability-disclosure policy required under CRA Annex I, Part II, point (5) is set out in the "Coordinated Vulnerability Disclosure (CVD) Policy" section above.

## No Bounty Program

Rakomi does not currently operate a paid bug bounty program. We deeply appreciate responsible disclosure and will acknowledge researchers in security advisories (with their consent).

## Reference: security.txt

This policy is referenced in our machine-readable security contact file (RFC 9116):
`/.well-known/security.txt` — deployed at `https://rakomi.com/.well-known/security.txt`

---

## What to Include in Your Report

*(ISO/IEC 29147:2018 §6.5)*

To help us triage efficiently, please include:

1. **Affected package** name and version (e.g., @rakomi/node 0.2.0)
2. **Reproduction steps** — a minimal, reproducible example
3. **Impact assessment** — what an attacker could achieve
4. **Proof of concept** — if available (do not use real user data)
5. **Reporter contact** — so we can keep you updated

Reports that do not include reproduction steps or fall outside the defined scope may be closed without a tracking ID.

## Report Tracking

*(ISO/IEC 29147:2018 §6.6)*

Each report receives a unique tracking identifier upon acknowledgment. For reports submitted via GitHub Private Vulnerability Reporting, the GHSA identifier (e.g., GHSA-xxxx-xxxx-xxxx) serves as the tracking ID. For email reports, we will direct you to also submit via GitHub PVR for formal tracking.

## Status Updates

*(ISO/IEC 29147:2018 §6.4)*

We provide status updates at least every **7 business days** for Critical/High severity issues, and upon resolution for Medium/Low severity issues.

## CVE Assignment

Confirmed vulnerabilities with sufficient impact will receive CVE identifiers via GitHub's CNA (CVE Numbering Authority) program.

## Reporter Data Privacy

*(GDPR Art. 6(1)(f) + Art. 13/14)*

Reporter personal data (name, email) is processed under GDPR Art. 6(1)(f) legitimate interest for vulnerability coordination. This data is:
- Retained for the duration of the vulnerability lifecycle plus 2 years
- Not shared with third parties except as required for CVE assignment or regulatory reporting (e.g., ENISA, national CSIRT)
- Accessible to the reporter upon request (GDPR Art. 15)
- Deletable upon request after vulnerability closure (GDPR Art. 17, where not overridden by regulatory retention obligations)

To exercise your GDPR rights, contact security@rakomi.com.

## PGP Key Fingerprint

The PGP public key for encrypted communication is available at:
`https://rakomi.com/rakomi-security-pgp-key.asc`

Verify the key fingerprint through an independent channel (e.g., LinkedIn, Twitter/X, or a direct phone call) before sending sensitive information.
