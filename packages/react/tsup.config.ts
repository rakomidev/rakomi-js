import { preserveDirectivesPlugin } from 'esbuild-plugin-preserve-directives'
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'components/sign-in/index': 'src/components/sign-in/index.ts',
    'components/sign-up/index': 'src/components/sign-up/index.ts',
    'components/user-button/index': 'src/components/user-button/index.ts',
    'components/user-profile/index': 'src/components/user-profile/index.ts',
    'components/billing/index': 'src/components/billing/index.ts',
    types: 'src/types.ts',
  },
  outDir: 'dist',
  format: ['esm', 'cjs'],
  dts: true,
  metafile: true,
  splitting: false,
  sourcemap: false,
  clean: true,
  external: ['@rakomi/sdk-core', 'react', 'react-dom', 'react/jsx-runtime'],
  noExternal: [],
  esbuildPlugins: [
    preserveDirectivesPlugin({
      directives: ['use client', 'use server', 'use strict'],
      include: /\.(js|ts|jsx|tsx)$/,
      exclude: /node_modules/,
    }),
  ],
  esbuildOptions(options) {
    options.write = false
  },
})
