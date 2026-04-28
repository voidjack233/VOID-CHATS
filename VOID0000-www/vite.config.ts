import { defineConfig, loadEnv, type PluginOption } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

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
  const apiProxyTarget = env.VITE_API_URL || 'http://localhost:3001'
  const conversationApiProxyTarget = env.VITE_CONVERSATION_API_URL || apiProxyTarget
  const messageApiProxyTarget = env.VITE_MESSAGE_API_URL || apiProxyTarget
  const socialApiProxyTarget = env.VITE_SOCIAL_API_URL || apiProxyTarget
  const gatewayProxyTarget = env.VITE_GATEWAY_URL || 'ws://localhost:4001'
  return {
    base: '/',
    plugins: [emitBuildVersionPlugin(buildVersion), react(), tailwindcss()],
    resolve: {
      alias: {
        crypto: fileURLToPath(new URL('./src/shims/browserCrypto.ts', import.meta.url)),
      },
    },
    define: {
      __BUILD_VERSION__: JSON.stringify(buildVersion),
    },
    server: {
      allowedHosts: true,
      proxy: {
        '^/api/conversations/[^/]+/messages': {
          target: messageApiProxyTarget,
          changeOrigin: true,
          secure: false,
        },
        '^/api/conversations/[^/]+/reactions': {
          target: messageApiProxyTarget,
          changeOrigin: true,
          secure: false,
        },
        '^/api/conversations/[^/]+/attachments': {
          target: messageApiProxyTarget,
          changeOrigin: true,
          secure: false,
        },
        '^/api/bootstrap': {
          target: conversationApiProxyTarget,
          changeOrigin: true,
          secure: false,
        },
        '^/api/conversations': {
          target: conversationApiProxyTarget,
          changeOrigin: true,
          secure: false,
        },
        '^/api/friends': {
          target: socialApiProxyTarget,
          changeOrigin: true,
          secure: false,
        },
        '^/api/users/search': {
          target: socialApiProxyTarget,
          changeOrigin: true,
          secure: false,
        },
        '^/api/users/profile': {
          target: socialApiProxyTarget,
          changeOrigin: true,
          secure: false,
        },
        '^/api/users/\\d+$': {
          target: socialApiProxyTarget,
          changeOrigin: true,
          secure: false,
        },
        '/api': {
          target: apiProxyTarget,
          changeOrigin: true,
          secure: false,
        },
        '/gateway': {
          target: gatewayProxyTarget,
          changeOrigin: true,
          ws: true,
        },
      },
    },
    preview: {
      proxy: {
        '^/api/conversations/[^/]+/messages': {
          target: messageApiProxyTarget,
          changeOrigin: true,
          secure: false,
        },
        '^/api/conversations/[^/]+/reactions': {
          target: messageApiProxyTarget,
          changeOrigin: true,
          secure: false,
        },
        '^/api/conversations/[^/]+/attachments': {
          target: messageApiProxyTarget,
          changeOrigin: true,
          secure: false,
        },
        '^/api/bootstrap': {
          target: conversationApiProxyTarget,
          changeOrigin: true,
          secure: false,
        },
        '^/api/conversations': {
          target: conversationApiProxyTarget,
          changeOrigin: true,
          secure: false,
        },
        '^/api/friends': {
          target: socialApiProxyTarget,
          changeOrigin: true,
          secure: false,
        },
        '^/api/users/search': {
          target: socialApiProxyTarget,
          changeOrigin: true,
          secure: false,
        },
        '^/api/users/profile': {
          target: socialApiProxyTarget,
          changeOrigin: true,
          secure: false,
        },
        '^/api/users/\\d+$': {
          target: socialApiProxyTarget,
          changeOrigin: true,
          secure: false,
        },
        '/api': {
          target: apiProxyTarget,
          changeOrigin: true,
          secure: false,
        },
        '/socket.io': {
          target: apiProxyTarget,
          changeOrigin: true,
          secure: false,
          ws: true,
        },
        '/gateway': {
          target: gatewayProxyTarget,
          changeOrigin: true,
          secure: false,
          ws: true,
        },
      },
    },
    build: {
      outDir: 'dist',
      rollupOptions: {
        onwarn(warning, defaultHandler) {
          const warningId = 'id' in warning ? warning.id : undefined
          const warningMessage = typeof warning.message === 'string' ? warning.message : ''

          const isKnownHpkePureAnnotationNoise =
            typeof warningId === 'string' &&
            warningId.includes('/node_modules/@hpke/common/') &&
            warningMessage.includes('contains an annotation that Rollup cannot interpret due to the position of the comment')

          if (isKnownHpkePureAnnotationNoise) {
            return
          }

          defaultHandler(warning)
        },
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
