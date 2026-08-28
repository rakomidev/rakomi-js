# create-rakomi-app

Scaffold a [Rakomi](https://rakomi.com) quickstart app in seconds. Rakomi is EU-native
authentication as a service.

## Getting started

```sh
npx create-rakomi-app@latest --template nextjs my-app
```

The `@latest` tag sidesteps a stale `npx` cache. The scoped `npm create` form also works:

```sh
npm create @rakomi/rakomi-app@latest -- --template nextjs my-app
```

> The unscoped `npm create rakomi-app` form is **not** supported — `npm create` cannot resolve a
> scoped package from the bare name. Use one of the two forms above. (An unscoped alias may be
> offered in the future.)

## Usage

| Slug     | Description       |
| -------- | ----------------- |
| `nextjs` | Next.js quickstart |
| `react`  | React quickstart   |
| `node`   | Node quickstart    |
| `expo`   | Expo quickstart    |

| Option                    | Meaning                                          |
| ------------------------- | ------------------------------------------------- |
| `--template <slug>`       | which quickstart to scaffold (required)            |
| `--region <value>`        | data region (default: `eu-central`)                |
| `--tenant-id <value>`     | your tenant id                                     |
| `--template-source <url>` | override the archive base (mirror / offline)       |
| `--yes`                   | accept defaults, never prompt (non-interactive)    |
| `-h`, `--help`            | show help                                          |
| `-V`, `--version`         | print the version                                  |

The CLI prompts for `RAKOMI_REGION`, `RAKOMI_TENANT_ID`, and `RAKOMI_API_KEY` and writes them to a
local `.env` in the new project. Value precedence is: flag > environment variable > prompt >
default. In a non-interactive context (a pipe, a continuous-integration job, or `--yes`) it never
blocks — it uses flags / environment values / defaults and leaves the rest for you to fill in.

`RAKOMI_REGION` defaults to `eu-central` — a visible data-residency stance, not a mandate. Override
it with `--region` or the `RAKOMI_REGION` environment variable for any other region.

## Caveats

- **`RAKOMI_API_KEY` is a credential.** It is read only from the prompt or the environment (never a
  command-line flag, which would persist in shell history), is written only to your local `.env`,
  is never printed back, and the new project's `.gitignore` is updated so you do not commit it.
- **No telemetry.** The CLI collects nothing and phones home about nothing. There is no usage
  analytics and nothing to opt out of.
- **Refuses to overwrite.** Scaffolding into a directory that already contains files is refused
  outright — your existing work is never clobbered. Pick a fresh directory name.
- **Scoped package name.** The published name is scoped, which is why the bare `npm create
  rakomi-app` form does not resolve; use the two supported invocations above.
- **Stores and transmits nothing else.** The only data involved is the values you type, written to
  your own local `.env` file on your own machine — exporting or deleting that data is simply
  reading or removing that file.
- The template list above is generated from a shared quickstart registry; a new quickstart becomes
  available here automatically once it is published.

## License

[MIT](./LICENSE) © CRE8EVE Sp. z o.o.
