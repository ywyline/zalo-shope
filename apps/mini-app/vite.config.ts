import reactRefresh from '@vitejs/plugin-react-refresh';
import path from 'node:path';
import { defineConfig } from 'vite';

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:3000';

export default defineConfig({
  base: './',
  build: {
    emptyOutDir: true,
    outDir: '../dist',
    polyfillModulePreload: false,
    rollupOptions: {
      output: {
        assetFileNames: 'assets/[name][extname]',
        chunkFileNames: 'assets/[name].[hash].js',
        entryFileNames: 'assets/app.module.js',
      },
    },
  },
  plugins: [reactRefresh()],
  publicDir: '../public',
  resolve: {
    alias: {
      '@zalo-shop/i18n': path.resolve(__dirname, '../../packages/i18n/src/index.ts'),
    },
  },
  root: './src',
  server: {
    host: '0.0.0.0',
    port: 5174,
    proxy: {
      '/api': {
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
        target: apiProxyTarget,
      },
    },
  },
});
