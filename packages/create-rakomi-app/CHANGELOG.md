## 0.1.2 — 2026-08-31

- Fix the CLI doing nothing when invoked through `npx create-rakomi-app` (or `npm create rakomi-app`). The entry guard compared `import.meta.url` against the raw `process.argv[1]`, but npm exposes the bin as a `node_modules/.bin` symlink and `pathToFileURL` does not resolve symlinks — so under npx the guard was false and the process exited 0 without scaffolding anything. The guard now resolves the real path of `argv[1]` before comparing; direct invocation is unchanged.

# create-rakomi-app
