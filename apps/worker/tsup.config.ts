import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  sourcemap: true,
  clean: true,
  skipNodeModulesBundle: true,
  noExternal: [/^@keyless\//, 'imapflow'],
  banner: {
    js: `import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);`,
  },
});
