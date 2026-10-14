import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import path from 'node:path'

export default defineConfig({
  plugins: [vue()],
  resolve: { alias: { '@shared': path.resolve(import.meta.dirname, 'src/shared') } },
  test: {
    include: ['test/**/*.test.ts', 'client/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15000,
  },
})
