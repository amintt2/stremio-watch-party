import { defineConfig } from 'vite';

// In dev, Discord's URL mapping (or your browser) hits Vite, which forwards /api to the backend.
export default defineConfig({
  server: {
    port: 5173,
    host: true,
    allowedHosts: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3001', ws: true, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true, chunkSizeWarningLimit: 1000 },
});
