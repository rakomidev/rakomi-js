# rakomi-js

The official JavaScript / TypeScript SDK family for [Rakomi](https://rakomi.com) — EU-native authentication (auth-as-a-service).

## Packages

| Package | Description |
| --- | --- |
| [`@rakomi/node`](./packages/sdk) | Server-side token & webhook verification for Node.js |
| [`@rakomi/sdk-core`](./packages/sdk-core) | Framework-agnostic authentication core |
| [`@rakomi/react`](./packages/react) | React hooks + prebuilt auth components |
| [`@rakomi/react-native`](./packages/react-native) | React Native / Expo SDK |

## Install

```bash
pnpm add @rakomi/node          # or @rakomi/react, @rakomi/react-native, @rakomi/sdk-core
```

## Documentation

- SDK reference & guides: <https://docs.rakomi.dev/sdk/>
- Verify a release yourself (npm build provenance / SLSA): [VERIFY.md](./VERIFY.md)
- Security policy & vulnerability reporting: [SECURITY.md](./SECURITY.md)

## License

MIT — see [LICENSE](./LICENSE).
