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
    // FUSION_ESPERAS_RAPIDAS acorta a 1 ms los backoff de reintento y las pausas entre llamadas
    // (lib/esperas.js): sin esto ~36 tests esperaban tiempo real (210 s, medido 2026-09-13).
    env: { SQLITE_UNSAFE_FAST: '1', FUSION_ESPERAS_RAPIDAS: '1' },
    // Con 2 CPU vitest usaba 1 solo proceso por defecto: los 144 archivos corrían de a uno
    // (medido 2026-09-13). Con 2 procesos la suite pasó de 593 s a 332 s, 0 fallos. No hay
    // archivos que compartan base temporal (verificado).
    maxWorkers: 2,
    exclude: ['**/node_modules/**', '**/.claude/worktrees/**', 'plataforma/**'],
  },
});
