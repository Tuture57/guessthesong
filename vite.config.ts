import { defineConfig } from 'vite';
import config from './config.js';

export default defineConfig({
  server: {
    port: 5173,
    // The API and the multiplayer socket live on their own port in development.
    proxy: {
      '/api': {
        target: `http://localhost:${config.server.port}`,
        changeOrigin: true,
      },
      '/ws': {
        target: `ws://localhost:${config.server.port}`,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
  },
});
