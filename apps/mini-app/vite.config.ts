import reactRefresh from '@vitejs/plugin-react-refresh';
import { defineConfig } from 'vite';

export default defineConfig({
  base: '',
  build: {
    emptyOutDir: true,
    outDir: '../dist',
    polyfillModulePreload: false,
  },
  plugins: [reactRefresh()],
  root: './src',
  server: {
    host: '0.0.0.0',
    port: 5174,
  },
});
