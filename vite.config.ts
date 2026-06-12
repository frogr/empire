import { defineConfig } from 'vite';

export default defineConfig({
  worker: { format: 'es' },
  server: { port: 5136 },
  build: { target: 'es2022' },
});
