## 0.3.3 — 2026-08-31

- Fix an unbounded sign-out broadcast loop when multiple `RakomiProvider` instances are mounted on the same page. Signing out from one instance now clears local state on the others without re-broadcasting the sign-out signal back to the channel, so co-resident instances converge in one round trip instead of echoing indefinitely. Cross-tab sign-out propagation (one tab signs out, other tabs pick it up) is unchanged.

# @rakomi/react
