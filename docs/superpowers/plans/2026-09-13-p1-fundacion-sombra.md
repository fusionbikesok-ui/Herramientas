# Plan P1 — Fundación en sombra

**Fecha:** 2026-09-13 · **Estado:** borrador para que José lo confirme antes de instalar nada ·
**Programa:** `2026-09-13-plataforma-auditable-catalogo-identidad-stock-pedidos.md` (aprobado) ·
**Ficha:** `deliveries/PLAT-1-fundacion.md`

## Qué entrega y qué no

Deja funcionando, al lado del sistema actual y **sin ninguna escritura en MercadoLibre ni Woo**, la
base sobre la que se van a mover las verticales P2–P5:

- PostgreSQL 18 con backups continuos y restauración a un momento puntual (cierra el PITR de Gate 0).
- Esquema base: empresa, cuentas de canal, usuarios, auditoría encadenada, colas durables.
- Autenticación con passkeys y roles.
- Workers y scheduler como procesos separados, con DLQ visible.
- Ingesta en sombra: las señales de ML y Woo (webhooks) se guardan también en el inbox nuevo, se
  releen y se registran, para medir que el núcleo recibe lo mismo que el legado.

**No entrega:** catálogo, identidad, stock ni pedidos en el sistema nuevo (P2–P4), ninguna pantalla
operativa nueva, ningún cambio en lo que hoy usa el equipo o la App.

Una tajada usable en sí misma: el día que termina, José ve un **reporte de diferencias en sombra**
(qué señales recibió el legado y cuáles el núcleo, cuáles faltan o llegaron duplicadas) y el backup
de la base nueva está probado con restauración.

## Decisiones fijadas

| Tema | Decisión | Origen |
|---|---|---|
| Ubicación del código | `plataforma/` dentro de este repo | José 2026-09-13 |
| Lenguaje y runtime | TypeScript estricto sobre Node 24 | plan §2.1 |
| Base | PostgreSQL 18 (última 18.x por digest) en Docker, mismo VPS | plan §2.1, §8 |
| Colas | inbox/outbox/comandos/intentos/DLQ en PostgreSQL con `FOR UPDATE SKIP LOCKED` | plan §2.1 |
| Auditoría | eventos encadenados por hash + manifiesto diario firmado en B2 con Object Lock | plan §4.1 |
| Claves de cifrado | archivo 600 en el VPS, fuera de repo y base, copia guardada por José fuera del VPS | José 2026-09-13 |
| Passkeys | catálogo y administración; iPhone, Mac/PC con biometría, compu sin biometría (QR/llave USB) y Android | José 2026-09-13, plan §4.2 |
| Responsable | José valida el reporte de sombra; técnico: asistente | José 2026-09-13 |
| Capacidad | VPS actual (2 CPU, 7,8 GB, ~3,4 GB libres); ampliación futura sin fecha | José 2026-09-13 |

## Presupuesto de recursos

| Proceso | RAM límite | CPU | Notas |
|---|---|---|---|
| PostgreSQL 18 | 768 MB | 0,75 | `shared_buffers` 192 MB; datos en volumen propio |
| API v2 (sombra) | 256 MB | 0,25 | sólo health, auth y lectura de estado |
| Worker + scheduler | 256 MB | 0,25 | un proceso, sin escritores remotos |
| **Total nuevo** | **~1,3 GB** | | deja ~2 GB libres; se mide antes y después |

Disco: PostgreSQL arranca < 1 GB; WAL archivado a B2, retención local mínima. Umbrales de Gate 0
siguen vigentes (alerta 70%).

## Pasos

Cada paso termina en algo verificable y con tests. El orden importa: primero lo que protege datos.

### 1. Esqueleto `plataforma/` y calidad
- `plataforma/package.json` (workspace del repo), `tsconfig` estricto, vitest, eslint, límites entre
  módulos (`catalog`, `identity`, `inventory`, `orders`, `fulfillment`, `integrations`, `security`,
  `audit`) verificados por lint: un módulo no importa internals de otro.
- Migraciones SQL versionadas (expand/contract) con un runner propio mínimo y tabla de control.
- **Aceptación:** `npm test` del repo corre los tests de `plataforma/` y del legado; CI local verde.

### 2. PostgreSQL con PITR probado
- Servicio en `deploy/plataforma/docker-compose.yml`, imagen por digest, límites, sólo `127.0.0.1`.
- Base backup diario + archivo continuo de WAL cifrado a B2 (prefijo propio, clave sin borrado),
  `pg_verifybackup`.
- Vigía: WAL sin archivar y antigüedad del último base backup → incidente (mismo sistema actual).
- **Aceptación:** restauración a un momento puntual en QA con RPO ≤ 5 min y RTO ≤ 1 h medidos; se
  anota en la ficha de Gate 0 y se cierra su último pendiente.

### 3. Esquema base y auditoría encadenada
- Tablas: `companies`, `channel_accounts`, `users`, `roles`, `capabilities`, `audit_events`
  (append-only, `prev_hash`/`hash` sobre contenido canónico), `audit_daily_manifests`.
- Triggers que impiden `UPDATE`/`DELETE` en `audit_events`; manifiesto diario firmado y subido a B2
  con Object Lock.
- Cifrado de PII por aplicación con clave externa; índices ciegos para búsquedas exactas.
- **Aceptación:** tests de restricciones (unicidad, FKs, archivo), cadena verificable de punta a
  punta, alteración de un evento detectada, manifiesto restaurable desde B2.

### 4. Colas durables y workers
- `inbox_messages`, `outbox_commands`, `command_attempts`, `dead_letters` con reclamo transaccional,
  lease, reintentos con backoff y DLQ.
- Proceso worker + scheduler separado de la API; nada queda `pending` fuera de su alcance (`parked`
  explícito).
- **Aceptación:** tests de concurrencia (dos workers no toman el mismo mensaje), caída entre efecto y
  confirmación, reintentos 403/408/429/5xx con fixtures, DLQ visible en `/api/v2/incidents`.

### 5. Autenticación con passkeys y roles
- WebAuthn (passkeys) para catálogo y administración, códigos de recuperación de un solo uso,
  reautenticación reciente para acciones de riesgo; operador puede seguir con contraseña.
- Roles base operador, catálogo, administración + capacidades finas; migración de usuarios del
  legado sin sus contraseñas (se enrolan).
- **Aceptación:** enrolamiento y login verificados en iPhone, Mac/PC con Touch ID o Windows Hello,
  compu sin biometría con iPhone como llave vía QR, y Android; recuperación con código probada.

### 6. Ingesta en sombra y reporte de diferencias
- Los webhooks de ML y Woo que ya recibe el legado se copian al `inbox_messages` nuevo (sin cambiar
  la respuesta ni el procesamiento del legado); el worker relee el recurso en modo lectura.
- Reporte diario para José: señales recibidas por cada lado, faltantes, duplicados y latencia.
- **Aceptación:** 7 días de sombra con 0 faltantes sin explicar y el reporte revisado por José.

## Riesgos y cómo se contienen

- **Memoria del VPS:** límites duros por contenedor y medición antes/después; si PostgreSQL empuja al
  legado, se baja `shared_buffers` antes de seguir.
- **Doble procesamiento:** la sombra nunca tiene credenciales de escritura de ML/Woo en esta etapa.
- **Claves perdidas:** sin la copia de José, un restore no puede leer PII cifrada; el paso 3 no se da
  por cerrado sin confirmar esa copia.
- **Alcance:** cualquier pantalla o migración de datos de negocio pertenece a P2+, no a este plan.

## Qué necesita José

1. Confirmar este plan (y el presupuesto de RAM).
2. Guardar fuera del VPS la clave de cifrado cuando se genere en el paso 3.
3. Probar el enrolamiento de passkey en sus dispositivos en el paso 5.
4. Revisar el reporte de sombra durante los 7 días del paso 6.
