# E3 corte 1 — verificación previa y lista de puesta en producción

## Verificación (2026-09-24, sin tocar producción)
- Plataforma `npm test`: 81 archivos, 847 verdes, 3 todo (corte 3). Salida cruda: `/tmp/claude-0/e3-plataforma.log`.
- Legado `npm test`: 165 archivos verdes (1 salteado), 3086 tests. Salida cruda: `/tmp/claude-0/e3-legado.log`. Se corrió con cambios ajenos sin commitear en el árbol.
- `npm run test:e3` (plataforma): 143 verdes + 3 `it.todo` (relectura con cambio, 5xx → parked, 401 aborta el canario: corte 3).
- QA con Postgres real: `node --experimental-strip-types scripts/qa/e3-bandeja-real.mjs` → 7/7. La pantalla real pasa por el proxy firmado del legado hacia la plataforma Fastify real; se verifica en la base la decisión con el actor de la sesión, la versión del caso, el vínculo, el deshacer (original superada + reversión) y omitir. Sin errores de consola.
- Contenedores de prueba: `rm -f -v` + verificación de que no queden volúmenes propios (los dangling previos —9— no crecieron).

## Pasos de producción (cada uno requiere OK de José; ninguno ejecutado)
1. Gate: suites verdes (hecho arriba) + `revisor` sobre el diff + Codex read-only + `auditor-despliegue`.
2. Migración 0020: `build` desde un worktree limpio, `migrate`, verificar `schema_migrations=20`. Antes: etiquetar la imagen actual `fusion-plataforma:antes-e3c1`.
3. Worker con `E3_MOTOR=1` y `E3_BANDEJA=0`: verificar una corrida del motor y los candidatos guardados.
4. Desplegar API y legado; luego `E3_BANDEJA=1` en worker y API. José decide 3 casos de prueba; verificar vínculo y auditoría.
5. Arrancar la ventana de calibración: registrar la fecha en la ficha E3 y en `docs/memory/active.md`.

Rollback: `E3_BANDEJA=0` (vuelve el legado, las decisiones se conservan); `E3_MOTOR=0`; imagen `antes-e3c1`.

Pendiente de configuración en el legado: `SOMBRA_PLATAFORMA_URL` y `SOMBRA_KEYRING_FILE` deben estar definidos para que el proxy no responda 503 `bandeja_no_configurada`.
