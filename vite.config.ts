import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: 'src/web',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:7421', changeOrigin: false },
    },
  },
});
