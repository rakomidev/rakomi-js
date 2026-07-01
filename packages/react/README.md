# @rakomi/react

React SDK for Rakomi Auth — `<RakomiProvider>`, hooks, pre-built UI components.

- Zero runtime dependencies beyond `react` (peer).
- Typed public API (`AuthState`, `UserResource`, `SessionResource`, …).
- Pre-built `<SignIn>`, `<SignUp>`, `<UserButton>`, `<UserProfile>` with localisation.

## Install

```bash
pnpm add @rakomi/react
```

## Quick start

```tsx
import { RakomiProvider, SignIn } from '@rakomi/react';

export function App() {
  return (
    <RakomiProvider publishableKey="pk_...">
      <SignIn />
    </RakomiProvider>
  );
}
```

## Localization

The SDK ships with 5 GA locales: **English (`en`)**, **Polish (`pl`)**, **German (`de`)**,
**French (`fr`)**, **Spanish (`es`)**.

### Explicit locale

```tsx
<RakomiProvider publishableKey="pk_..." locale="de">
  <SignIn />
</RakomiProvider>
```

### Tenant default (auto-detected)

Omit the `locale` prop — the SDK falls back to the tenant's configured default
locale (`GET /v1/public/tenant-config`), then the browser's `navigator.language`,
then `'en'`.

```tsx
<RakomiProvider publishableKey="pk_...">
  <SignIn />
</RakomiProvider>
```

### Custom translation overrides

Pass a partial `Translations` object via `translations` — missing keys fall through
to the selected locale dictionary, then to English.

```tsx
import { RakomiProvider } from '@rakomi/react';
import type { Translations } from '@rakomi/react';

const overrides: Partial<Translations> = {
  'signIn.title': 'Welcome back',
  'signIn.submitButton': 'Let me in',
};

<RakomiProvider publishableKey="pk_..." locale="en" translations={overrides}>
  <SignIn />
</RakomiProvider>;
```

Priority order (highest first):
1. Component-level override
2. `RakomiProvider translations` prop
3. Locale dictionary (`de` / `fr` / `es` / `pl` / `en`)
4. English fallback

### Plural forms

The SDK supports ICU-style plural patterns:

```tsx
// 2-form (en, de, es, fr)
'{count, plural, one {# item} other {# items}}'

// French uses CLDR: 0 and 1 are both "one".
// Polish 4-form (one / few / many / other):
'{count, plural, one {# sesja} few {# sesje} many {# sesji} other {# sesji}}'
```

### Error messages

If the API returns `message_localized` (see `error.message_localized`), render it
in preference to `error.message`:

```tsx
const text = err.message_localized ?? err.message;
```

`error.message` is always English (machine-oriented); `error.message_localized` is
optional — never substitute one for the other.

### Translation quality

DE / FR / ES translations are AI-generated and glossary-enforced for terminology
consistency. Report any end-user-facing translation bug via GitHub Issues —
corrections are rolled into the next minor release.
