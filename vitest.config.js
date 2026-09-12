import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // La suite de migraciones abre una base SQLite desde cero y ejecuta todo el
    // historial; en VPS lentos puede superar el default de 5 s sin estar colgada.
    testTimeout: 15000,
    // Cada test abre su propia base y corre las 68 migraciones. El 90% de ese costo es fsync,
    // no las migraciones (ver el comentario en db/index.js). Con el journal en memoria la suite
    // completa deja de costar ~50 minutos. Es seguro acá y sólo acá: estas bases son temporales
    // y se borran en el afterEach; si se corrompe una, no se pierde nada.
    env: { SQLITE_UNSAFE_FAST: '1' },
    exclude: ['**/node_modules/**', '**/.claude/worktrees/**'],
  },
});
