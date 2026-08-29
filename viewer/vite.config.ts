import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // This value is consumed only by the Vite development server. Browser code
  // continues to use relative /api and /project-files URLs.
  const environment = loadEnv(mode, process.cwd(), 'HUB_')
  const hubBackendUrl = environment.HUB_BACKEND_URL ?? 'http://localhost:3101'

  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api': { target: hubBackendUrl, changeOrigin: true },
        '/project-files': { target: hubBackendUrl, changeOrigin: true },
      },
    },
  }
})
