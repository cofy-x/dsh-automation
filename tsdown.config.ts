import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'lib/types/index.js',
    domain: 'lib/types/domain.js',
    store: 'lib/types/store.js',
    startup: 'lib/types/startup.js',
    app: 'lib/types/app.js',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
