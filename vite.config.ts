import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:4310' },
  },
  // Verification must not replace assets served by a running production controller.
  build: { outDir: process.env.AGENT_VERIFY_BUILD === 'true' ? '.verification/build' : 'dist', sourcemap: true },
});
