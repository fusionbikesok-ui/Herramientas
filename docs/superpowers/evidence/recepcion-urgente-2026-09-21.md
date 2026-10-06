# Evidencia — Recepción urgente sobre el legado

Fecha de ejecución: 2026-09-22 UTC

## Alcance verificado

- Matcher automático ejecutado en backend.
- Alias por proveedor versionados y revocables.
- Estados de matching visibles en Recepción.
- Alta Woo con `draft`, stock cero e idempotencia local.
- Alta asistida conectada desde una línea sin match, con modos simple, familia variable y variación existente, y `operation_id` visible ante incertidumbre.
- Drafts nuevos excluidos de la sincronización inicial a Mercado Libre.
- Resultado parcial de recepción con estado `confirmada_con_pendientes`.
- Reintento restringido a líneas con error.
- Auditoría histórica read-only.

## Resultados

| Comando | Resultado |
|---|---|
| `npm test` | PASS — 160 archivos, 2769 tests, 51 skipped |
| `npm run e2e:recepcion-urgente` | PASS — 390, 768 y 1440 px |
| `node scripts/audit-recepcion-urgente.mjs --db data/fusion.sqlite` | PASS — 22 total, 0 automáticos, 22 revisión, 0 sin match |
| `cd plataforma && npm run typecheck` | PASS |
| `cd plataforma && npm test` | PASS — 69 archivos, 670 tests |
| ESLint acotado a archivos de la iniciativa | PASS — 0 errores |
| `git diff --check` | PASS |
| `npm run docs:validate-deliveries` | PASS — 27 fichas y cobertura PM válidas |
| `npm run verify:mobile-contract` | PASS — contrato 1.0.0, 53 paths |

## Gates preexistentes no atribuibles

- `npm run lint` global falla por deuda histórica distribuida en el repositorio; no se amplió el alcance para corregirla.

## Seguridad de pruebas

- No se utilizaron APIs reales de WooCommerce, Mercado Libre ni Gemini.
- El E2E utiliza servidor, SQLite y credenciales temporales locales.
- La auditoría abrió `data/fusion.sqlite` en modo read-only y confirmó que no cambió durante una ejecución aislada.
- Una ejecución posterior detectó cambios concurrentes de un proceso `server.js` ya existente; por diseño la auditoría falló cerrado y no se detuvo ni modificó ese proceso.
- Los 22 casos históricos fueron clasificados sin modificar la base.

## Cambios ajenos preservados

Se conservaron los cambios preexistentes del worktree, incluidos los de memoria, clasificación de plataforma, documentación y Gemini.
