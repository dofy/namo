import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  root: fileURLToPath(new URL('./ui', import.meta.url)),
  publicDir: false,
  envPrefix: 'NAMO_UI_PUBLIC_',
  define: { __NAMO_VERSION__: JSON.stringify(version) },
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
