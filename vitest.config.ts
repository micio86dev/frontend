import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [vue()],
  // Define import.meta.client as true in Vitest (mirrors Nuxt client-side bundle context).
  // Provider code uses `import.meta.client` to guard browser-only SDK imports from SSR.
  // Unit tests run in happy-dom (client-like environment) so this is the correct default.
  define: {
    'import.meta.client': true,
    'import.meta.server': false,
  },
  test: {
    globals: true,
    environment: 'happy-dom',
    setupFiles: ['./tests/unit/setup.ts'],
    // Only run unit tests; Playwright E2E runs separately via playwright test
    include: ['tests/unit/**/*.spec.ts', 'tests/unit/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**', '.nuxt/**'],
    coverage: {
      provider: 'v8',
      include: ['app/**', 'components/**', 'composables/**', 'pages/**', 'server/**'],
      exclude: [
        '.nuxt/**',
        'types/api.ts',
        '*.config.*',
        // Exclude pure TypeScript type definition files — they contain no runtime code
        // (only interface/type declarations) so v8 reports them as 0% covered.
        'app/types/**',
      ],
      thresholds: {
        lines: 85,
      },
    },
  },
  resolve: {
    alias: {
      '~': resolve(__dirname, '.'),
      '@': resolve(__dirname, '.'),
    },
  },
})
