import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'oauth/errors': 'src/oauth/errors.ts',
    'oauth/pkce': 'src/oauth/pkce.ts',
    'types/adapters': 'src/types/adapters.ts',
  },
  outDir: 'dist',
  format: ['esm', 'cjs'],
  dts: true,
  metafile: true,
  splitting: false,
  sourcemap: false,
  clean: true,
  treeshake: true,
  external: ['jose'],
  noExternal: [],
})
