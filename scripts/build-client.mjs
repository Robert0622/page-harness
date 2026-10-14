// Builds every browser-side bundle into dist/client.
//   dist/client/page/{overlay,page-control,live-overlay}.js  — IIFE, injected into the target page
//   dist/client/app/                                          — Vue panel + history (served from the control origin)
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const alias = { '@shared': path.join(root, 'src/shared') }
const watch = process.argv.includes('--watch') ? {} : null
const minify = !process.argv.includes('--no-minify')

const pageScripts = [
  ['overlay', 'client/overlay/index.ts'],
  ['page-control', 'client/page-control/index.ts'],
  ['live-overlay', 'client/live-overlay/index.ts'],
]

for (const [name, entry] of pageScripts) {
  await build({
    configFile: false,
    root,
    logLevel: 'warn',
    resolve: { alias },
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
      outDir: 'dist/client/page',
      emptyOutDir: false,
      minify,
      sourcemap: false,
      watch,
      lib: { entry: path.join(root, entry), name: `__ph_${name.replace('-', '_')}`, formats: ['iife'], fileName: () => `${name}.js` },
    },
  })
}

await build({
  configFile: false,
  root: path.join(root, 'client/app'),
  base: '/__ph/app/',
  logLevel: 'warn',
  plugins: [vue()],
  resolve: { alias },
  build: {
    outDir: path.join(root, 'dist/client/app'),
    emptyOutDir: true,
    minify,
    watch,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: {
        panel: path.join(root, 'client/app/panel.html'),
        history: path.join(root, 'client/app/history.html'),
      },
    },
  },
})

console.log('client bundles built')
