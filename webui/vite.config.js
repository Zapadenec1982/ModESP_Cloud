import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  // The landing page (landing/) owns "/"; the app is served from /cloud/
  // (infra/nginx/modesp.conf). Hash routes (#/…) are unaffected.
  base: '/cloud/',
  plugins: [svelte()],
  server: {
    port: 5173,
    host: true,  // listen on 0.0.0.0 — accessible from LAN
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,
      },
    },
  },
});
