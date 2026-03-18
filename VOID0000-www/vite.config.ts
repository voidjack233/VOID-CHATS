import { defineConfig, loadEnv, type PluginOption } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

function emitBuildVersionPlugin(buildVersion: string): PluginOption {
  return {
    name: 'emit-build-version',
    generateBundle(this: { emitFile: (file: { type: 'asset'; fileName: string; source: string }) => void }) {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify(
          {
            version: buildVersion,
            builtAt: new Date(Number(buildVersion)).toISOString(),
          },
          null,
          2
        ),
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const buildVersion = Date.now().toString()
  return {
    base: '/',
    plugins: [emitBuildVersionPlugin(buildVersion), react(), tailwindcss()],
    define: {
      __BUILD_VERSION__: JSON.stringify(buildVersion),
    },
    server: {
      allowedHosts: true,
      proxy: {
        '/api': {
          target: 'http://localhost:3001',
          changeOrigin: true,
          secure: false,
        },
        '/gateway': {
          target: 'ws://localhost:3001',
          changeOrigin: true,
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
      rollupOptions: {
        output: {
          manualChunks: {
            'vendor-react': ['react', 'react-dom', 'react-router-dom'],
            'vendor-socket': ['socket.io-client'],
            'vendor-ui': ['lucide-react', 'react-virtuoso'],
            'vendor-misc': ['dompurify', 'uuid'],
          },
        },
      },
    },
  }
})
