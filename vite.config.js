import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: './', // relative path for GitHub Pages compatibility
  resolve: {
    alias: {
      'node-datachannel/polyfill': path.resolve(__dirname, 'src/empty-shim.js'),
      'node-datachannel': path.resolve(__dirname, 'src/empty-shim.js')
    }
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      manifest: {
        name: 'Axona Track',
        short_name: 'axona.track',
        description: 'Mobile PWA Network Behavior & Role Telemetry App for Axona Mesh',
        theme_color: '#090d16',
        background_color: '#090d16',
        display: 'standalone',
        orientation: 'portrait-primary',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable'
          }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}']
      }
    })
  ],
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true
  }
});
