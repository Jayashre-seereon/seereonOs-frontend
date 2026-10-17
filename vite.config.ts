import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { viteSingleFile } from 'vite-plugin-singlefile'
import path from 'node:path'
import { loadEnv } from 'vite'

// `npm run build:preview` produces one self-contained HTML file (hash routing, mock API)
// used for the hosted clickable preview. Normal builds are a standard SPA.
// `npm run build:http` (vite build --mode http, see .env.http) talks to the real API at /api/v1; the API server
// serves that build from dist/. In `vite --mode http` the dev server proxies /api to the API (API_PROXY_TARGET).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiOrigin = env.VITE_API_ORIGIN || 'http://localhost:8000'
  return ({
  plugins: [react(), tailwindcss(), ...(mode === 'preview' ? [viteSingleFile()] : [])],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  server: {
    proxy: { '/api': { target: apiOrigin, changeOrigin: false } },
  },
  build: {
    outDir: mode === 'preview' ? 'dist-preview' : 'dist',
    chunkSizeWarningLimit: 4000,
  },
  })
})
