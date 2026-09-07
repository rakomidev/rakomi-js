## 0.3.4 — 2026-09-06

- Fix: pre-built components' submit button, `<UserButton>` avatar, and the error-boundary retry button now paint their resting background from a dedicated fill colour (the tenant's `buttonColor` when set, falling back to `primaryColor`) instead of always reading the accent colour. The computed ink for that fill (`--rakomi-color-primary-foreground`) was already derived from the same value the hover state uses; only the resting background had been reading a different variable. For a tenant whose `buttonColor` differs from `primaryColor` — the documented, intended way to use the two fields — this could previously pair the button's background with a computed ink meant for a different colour, in the worst case producing a WCAG-AA contrast failure. No API change; no action needed unless you override `--rakomi-color-primary` directly in custom CSS, in which case also set `--rakomi-color-primary-fill` to match your intended button colour.

## 0.3.3 — 2026-08-31

- Fix an unbounded sign-out broadcast loop when multiple `RakomiProvider` instances are mounted on the same page. Signing out from one instance now clears local state on the others without re-broadcasting the sign-out signal back to the channel, so co-resident instances converge in one round trip instead of echoing indefinitely. Cross-tab sign-out propagation (one tab signs out, other tabs pick it up) is unchanged.

# @rakomi/react
