import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // La suite de migraciones abre una base SQLite desde cero y ejecuta todo el
    // historial; en VPS lentos puede superar el default de 5 s sin estar colgada.
    testTimeout: 15000,
    exclude: ['**/node_modules/**', '**/.claude/worktrees/**'],
  },
});
