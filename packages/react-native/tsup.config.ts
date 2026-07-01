import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'native/index': 'src/native/index.ts',
  },
  outDir: 'dist',
  format: ['esm', 'cjs'],
  dts: true,
  metafile: true,
  splitting: false,
  sourcemap: false,
  clean: true,
  treeshake: true,
  external: ['@rakomi/sdk-core', 'expo', 'jose', 'react', 'react-native', 'react/jsx-runtime'],
  noExternal: [],
})
