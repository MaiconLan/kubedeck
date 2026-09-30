import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: `npm run dev:server` listens on 7420; Vite proxies the API there.
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:7420', changeOrigin: false },
    },
  },
});
