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
        // Middleware is excluded from Vitest threshold (integration concern).
        // SSR-path coverage is Playwright's responsibility (spec Coverage Note).
        'app/middleware/**',
        // shadcn-vue installed UI primitives — third-party components, not project logic.
        // Covered by shadcn-vue's own test suite; excluded from project coverage threshold.
        'app/components/ui/**',
        // app/lib — shadcn-vue utility (cn helper); third-party scaffolding.
        'app/lib/**',
        // Interview pages — ssr:false container pages; covered by Playwright E2E.
        // Unit tests for business logic live in composable specs.
        'app/pages/interview/**',
        // Client-only browser-SDK components — covered by Playwright E2E (no VTU required).
        'app/components/AvatarPlayer.client.vue',
        'app/components/DeviceCheck.client.vue',
        'app/components/ProctorOverlay.client.vue',
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
