import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const apiTarget = process.env.VITE_API_TARGET ?? 'http://127.0.0.1:8000'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Proxy API calls to FastAPI during local development.
      '/projects': apiTarget,
      '/jobs': apiTarget,
      '/health': apiTarget,
      '/dev': apiTarget,
    },
  },
})
