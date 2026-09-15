# E1 · Tramo 2 — Plan de implementación de barridos

**Estado:** listo para ejecutar; especificación aprobada por José el 2026-09-15.  
**Spec:** [diseño T2](../specs/2026-09-15-e1-tramo2-barridos-design.md).  
**Alcance autorizado:** código, migraciones y pruebas contra infraestructura efímera. No producción,
E0, credenciales reales, ML/Woo reales ni copia de webhooks del legado.

## Precondiciones

1. `8b9303d` o posterior presente y cambios locales identificados.
2. Docker disponible, puertos efímeros y ningún `test:e1` concurrente.
3. Tramo 1, typecheck y validador documental verdes.
4. Una contradicción con la spec detiene el corte; no se resuelve improvisando código.

## Corte 1 — SQL y cifrado

**Archivos:** `specs/e1/schema.sql`, `migrations/0003_reconciliacion.sql`,
`src/seguridad/sobre.ts`, tests de esquema y sobre.

1. Convertir el cursor a JSONB validado; agregar `cursor_kind`, `enabled` y PK nueva.
2. Expandir `sweep_runs` con estados, lease, cursores y unicidad activa.
3. Crear observaciones y relaciones con checks, FKs, índices y retención.
4. Agregar el sobre AES-256-GCM al inbox y actualizar permisos en la migración.
5. Probar desde cero, desde 0001+0002, reaplicación, checks, AAD alterado y key id desconocido.

```bash
npm --prefix plataforma run typecheck
npm --prefix plataforma test -- test/reconciliacion/esquema.test.ts test/seguridad/sobre.test.ts test/migraciones.test.ts
git diff --check
```

Commit: `feat(plataforma): agrega contrato relacional y cifrado para barridos E1`.

## Corte 2 — Programación y leases

**Archivos:** `src/reconciliacion/corridas.ts`, `src/scheduler/scheduler.ts`,
`src/worker/worker.ts`, `src/worker/main.ts`, `test/reconciliacion/corridas.test.ts`.

Implementar calendario, corrida única, reclamo `SKIP LOCKED`, renovación/liberación, backoff,
agotamiento y avance optimista. El worker sólo reclama tópicos con adaptador. SIGTERM libera el lease
sin sumar intento.

Pruebas: dos schedulers, dos workers, lease vencido, ocho intentos, `Retry-After`, corriente apagada y
conflicto de cursor.

```bash
npm --prefix plataforma test -- test/reconciliacion/corridas.test.ts test/scheduler.test.ts
```

Commit: `feat(plataforma): programa y reclama barridos durables E1`.

## Corte 3 — Motor y observaciones

**Archivos:** `src/reconciliacion/tipos.ts`, `canonico.ts`, `motor.ts` y `motor.test.ts`.

Implementar transporte inyectado de lectura, página validada completa, ventana congelada,
transacciones idempotentes, comparación timestamp/hash, proyecciones, relaciones y bajas sólo tras
full scan exitoso. Run y cursor cierran en una transacción.

Pruebas: duplicado, fecha vieja, hash igual/distinto, falla en página 3, replay, relaciones, ausencia
en parcial y baja tras corrida completa.

```bash
npm --prefix plataforma test -- test/reconciliacion/motor.test.ts
```

Commit: `feat(plataforma): implementa motor transaccional de reconciliación E1`.

## Corte 4 — Ocho adaptadores y simulador

**Archivos:** `scripts/qa/simulador-canales.mjs`, `src/reconciliacion/cliente-http.ts`,
`src/reconciliacion/adaptadores/*.ts`, fixtures y `adaptadores.test.ts`.

Agregar fixture inyectado en memoria, reloj, páginas y mutaciones deterministas. Implementar los ocho
adaptadores con endpoints, headers, límites e identidades de la matriz. El cliente rechaza métodos no
GET, destinos no permitidos, redirecciones y cuerpos mayores a 10 MiB; timeout 5 s y máximo cuatro
conexiones. Nunca registra Authorization, query secrets ni cuerpos.

Pruebas: fixture no vacío por tópico, `x-format-new`, `mark_as_read=false`, GMT, ventanas,
variaciones, 404, 401/403, 408/429/5xx, timeout, redirección y destino prohibido.

```bash
npm --prefix plataforma test -- test/reconciliacion/adaptadores.test.ts
```

Commit: `feat(plataforma): agrega adaptadores y simulador temporal de barridos E1`.

## Corte 5 — Contrato acumulativo

**Archivos:** `contrato-tramo2.test.ts`, `compose.test.yml`, `scripts/test-e1.sh` y `test-e1.md`.

`E1_TRAMO=2 npm run test:e1` exige los IDs acumulativos de T1 y los once de T2. Falla si falta un ID,
un fixture está vacío, un payload queda plano, el transporte de canal usa otro método o queda un
contenedor. El keyring se crea en `mktemp` y se monta read-only.

Pruebas mutantes temporales: retirar `window_to`, permitir avance tras página 3, quitar dedupe,
declarar baja parcial, omitir `x-format-new`, persistir plano y permitir URL externa. Cada mutante debe
hacer fallar su escenario antes de descartarse.

```bash
pgrep -af "vitest|node.*server"
npm --prefix plataforma run typecheck
npm --prefix plataforma test
E1_TRAMO=2 npm run test:e1
npm run docs:validate-deliveries
git diff --check
docker ps -a --format '{{.Names}}' | rg 'fusion-e1|plataforma-test' || true
```

Después, correr una vez la suite legacy en serie porque cambia el simulador compartido.

Commit: `test(plataforma): certifica barridos del tramo 2 de E1`.

## Salida

Una revisión final relaciona cada fila de la matriz con adaptador, fixture, observación, prueba y
métrica. No se despliega. T2 verificado no acepta E1: aún faltan T3 y T4. El próximo trabajo será
diseñar T3; este plan nunca autoriza conexión a canales reales.
