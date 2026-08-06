import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  base: './',   // CRITICAL: enables relative paths so Electron can load via file:// protocol
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,   // FAIL immediately if :5173 is occupied — never drift to 5174
    host: true,
  }
});
