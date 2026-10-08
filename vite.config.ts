import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const repository = process.env.GITHUB_REPOSITORY?.split('/')[1];
const base = `/${repository || 'anatomy-study-pwa'}/`;

export default defineConfig({
  base,
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/three/')) return 'vendor-three';
          if (id.includes('/node_modules/pdfjs-dist/')) return 'vendor-pdf';
          if (id.includes('/node_modules/')) return 'vendor';
        }
      }
    }
  },
  plugins: [
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['icons/icon.svg', 'icons/apple-touch-icon.png'],
      manifest: {
        name: 'Anatomy Study',
        short_name: 'Anatomy',
        description: 'Private offline exercise file library and anatomy viewer.',
        theme_color: '#f5f7fa',
        background_color: '#f5f7fa',
        display: 'standalone',
        start_url: base,
        scope: base,
        icons: [
          { src: `${base}icons/icon.svg`, sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: `${base}icons/icon-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: `${base}icons/icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest,glb,mjs}'],
        maximumFileSizeToCacheInBytes: 30 * 1024 * 1024,
        navigateFallback: 'index.html',
        runtimeCaching: [
          {
            urlPattern: /pdf\.worker.*\.mjs$/,
            handler: 'CacheFirst',
            options: { cacheName: 'pdf-workers', expiration: { maxEntries: 2, maxAgeSeconds: 31536000 } }
          },
          {
            urlPattern: /\/__thumbnails\/[^/]+$/,
            handler: 'CacheFirst',
            options: { cacheName: 'anatomy-pdf-thumbnails-v1', expiration: { maxEntries: 100, maxAgeSeconds: 31536000 } }
          }
        ]
      },
      devOptions: { enabled: false }
    })
  ],
  resolve: { alias: { '@': '/src' } }
});
