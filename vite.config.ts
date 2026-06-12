import { defineConfig } from 'vite';

export default defineConfig({
  worker: { format: 'es' },
  server: {
    port: 5136,
    proxy: {
      '/api': 'http://localhost:8136',
    },
  },
  build: { target: 'es2022' },
});
