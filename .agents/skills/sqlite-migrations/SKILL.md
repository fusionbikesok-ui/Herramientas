---
name: sqlite-migrations
description: Convención de migraciones .sql numeradas de FusionBikes (migrations/NNN_nombre.sql, better-sqlite3) — qué revisar antes de agregar o modificar una tabla/índice, y por qué un cambio de esquema siempre escala en la matriz de riesgo (agents/model-routing.md).
---

# Migraciones sqlite en FusionBikes

## Convención observada en `migrations/`

- Archivos numerados con tres dígitos y guion bajo: `NNN_nombre_descriptivo.sql` (ej.
  `081_guardia_ml_aprendizajes.sql`). El número es secuencial y global, no por tabla ni por
  feature — antes de crear uno, mirar el último número existente (`ls migrations/ | tail -1`).
- SQL puro, sin bloques de transacción explícitos por archivo — `better-sqlite3` corre cada
  statement.
- `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` — las migraciones deben ser
  **idempotentes**: re-aplicar un archivo ya corrido no debe fallar ni duplicar datos.
- Índices en archivo aparte o al final del mismo archivo que crea la tabla, nombrados
  `idx_<tabla>_<columna(s)>`.

## Qué revisar antes de escribir una migración nueva

1. **¿Hay datos existentes que necesitan backfill?** Un `ALTER TABLE ... ADD COLUMN` con
   `NOT NULL` sin `DEFAULT` rompe contra una tabla con filas — en este repo eso significa
   producción real, no un ambiente de prueba.
2. **¿La columna nueva participa de una invariante de concurrencia?** Si la tabla es
   `guardia_ml_casos`, `guardia_ml_operaciones` o cualquier tabla con optimistic locking
   (`expected_version`), ver [[concurrencia-guardia]] antes de tocar el esquema — un campo nuevo
   mal integrado en el ciclo de versión puede reabrir la misma clase de bug.
3. **¿El cambio afecta una tabla que `sync.js` lee en el CTE de stock computado**
   (`COMPUTED_STOCK_CTE`)? Un JOIN o WHERE nuevo ahí cambia qué publicaciones reciben stock —
   tratarlo como cambio de negocio, no solo de esquema.
4. **Migraciones hacia atrás no existen en este repo** (no hay `NNN_down.sql`). Si una migración
   sale mal en producción, la corrección es una migración nueva que revierte el efecto, nunca
   editar o borrar la ya aplicada.

## Por qué esto dispara la escalera de riesgo

`agents/model-routing.md` marca "esquema sqlite" como uno de los disparadores que sacan la
implementación de `gpt-5.6-luna`/low: un cambio de esquema mal migrado en este repo no se prueba
contra un ambiente de staging — se aplica contra `data/fusion.sqlite` real, con PM2 corriendo el
proceso `herramientas` sin pausa. Verificación antes de dar por buena cualquier migración:

1. Backup explícito de `data/fusion.sqlite` antes de aplicar (`cp` con timestamp, no confiar en
   el `.bak-*` más reciente si es de otra sesión).
2. Aplicar en una copia de la base primero (`sqlite3`/`better-sqlite3` contra un archivo
   temporal), nunca directo contra la real como primer intento.
3. Confirmar que `pm2 list` sigue con el proceso `herramientas` `online` después de aplicar.
