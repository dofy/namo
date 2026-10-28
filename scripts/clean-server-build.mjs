import { rmSync } from 'node:fs';

// TypeScript does not remove output for renamed or deleted source files.
for (const directory of ['src', 'test', 'scripts']) {
  rmSync(new URL(`../dist/${directory}`, import.meta.url), { recursive: true, force: true });
}
