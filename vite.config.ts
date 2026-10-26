import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('./ui', import.meta.url)),
  publicDir: false,
  envPrefix: 'NAMO_UI_PUBLIC_',
  build: {
    outDir: '../dist/ui',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    rolldownOptions: {
      onwarn(warning, warn) {
        // This is a browser-only SPA; Radix's RSC boundaries have no role here.
        if (warning.code === 'MODULE_LEVEL_DIRECTIVE' && warning.message.includes('"use client"') && warning.message.includes('node_modules')) return;
        warn(warning);
      },
    },
  },
});
