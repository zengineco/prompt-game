// ============================================================
// PROMPT Activity — Vite config
// Tuned for the Discord Activity dev loop (cloudflared tunnel + proxy)
// Zengine™ | www.zengine.site
// ============================================================
import { defineConfig } from 'vite';

export default defineConfig({
  envPrefix: 'VITE_',
  server: {
    port: 3000,
    // Discord loads the Activity through a proxy host; allow it + tunnel hosts
    allowedHosts: true,
    // HMR must report port 443 so it works behind the HTTPS tunnel
    hmr: { clientPort: 443 }
  },
  build: {
    target: 'esnext'
  }
});
