import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
export default defineConfig({
  root,
  esbuild: {
    tsconfigRaw: {
      compilerOptions: { target: 'ES2022', useDefineForClassFields: false },
    },
  },
  resolve: {
    alias: {
      '@affine/realtime': root + 'packages/common/realtime/src/index.ts',
    },
  },
  test: {
    include: [
      'packages/common/nbstore/src/realtime/__tests__/*.spec.ts',
      'tools/xenica-mcp/auth-guard-cache.spec.ts',
      'tools/xenica-mcp/socket-identity.spec.ts',
      'tools/xenica-mcp/auth-identity-order.spec.ts',
    ],
    maxWorkers: 1,
  },
});
