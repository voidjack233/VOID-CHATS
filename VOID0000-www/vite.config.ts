import { defineConfig, loadEnv } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    base: './',
    plugins: [react(), tailwindcss()],
    define: {
      __BUILD_VERSION__: JSON.stringify(Date.now().toString()),
    },
    server: {
      allowedHosts: true,
      proxy: {
        '/api': {
          target: env.VITE_API_URL,
          changeOrigin: true,
          secure: false,
        },
        '/socket.io': {
          target: env.VITE_API_URL,
          changeOrigin: true,
          secure: false,
          ws: true,
        },
      },
    },
    preview: {
      proxy: {
        '/api': {
          target: env.VITE_API_URL,
          changeOrigin: true,
          secure: false,
        },
        '/socket.io': {
          target: env.VITE_API_URL,
          changeOrigin: true,
          secure: false,
          ws: true,
        },
      },
    },
    build: {
      outDir: 'dist',
    },
  }
})
