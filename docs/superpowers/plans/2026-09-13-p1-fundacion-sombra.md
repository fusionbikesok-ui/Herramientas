# Plan P1 — Fundación en sombra

**Fecha:** 2026-09-13 · **Estado:** borrador corregido tras revisión (2026-09-13); requiere P0 cerrado y confirmación de José ·
**Programa:** `2026-09-13-plataforma-auditable-catalogo-identidad-stock-pedidos.md` (aprobado) ·
**Ficha:** `deliveries/PLAT-1-fundacion.md`

## Qué entrega y qué no

Deja funcionando, al lado del sistema actual y **sin ninguna escritura en MercadoLibre ni Woo**, la
base sobre la que se van a mover las verticales P2–P5:

- Esquema base sobre el PostgreSQL que **deja listo P0** (instancia vacía, WAL archivado y PITR
  probado son condición de entrada, no parte de P1): empresa, cuentas de canal, usuarios, auditoría
  encadenada, colas durables.
- Autenticación con passkeys y roles.
- Workers y scheduler como procesos separados, con DLQ visible.
- Ingesta en sombra: las señales de ML y Woo (webhooks) se guardan también en el inbox nuevo, se
  releen y se registran, para medir que el núcleo recibe lo mismo que el legado.

**No entrega:** catálogo, identidad, stock ni pedidos en el sistema nuevo (P2–P4), ninguna pantalla
operativa nueva, ningún cambio en lo que hoy usa el equipo o la App.

Una tajada usable en sí misma: el día que termina, José ve un **reporte de diferencias en sombra**
(qué señales recibió el legado y cuáles el núcleo, cuáles faltan o llegaron duplicadas), con la
auditoría encadenada y las colas funcionando sobre la base que P0 dejó respaldada y restaurable.

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
| Prueba de passkeys | P1 las valida con autenticador virtual (WebAuthn en tests); la prueba en dispositivos reales es **condición para activarlas** en P2, cuando exista `qa-herramientas` con HTTPS | José 2026-09-13 |
| Procesos | API, worker y scheduler como **servicios separados** (misma imagen, contenedores distintos) | plan §2.1, revisión 2026-09-13 |
| Sombra | la copia al inbox nuevo **nunca** afecta el ACK ni el procesamiento del legado; la fuente de conciliación es la relectura de ML/Woo | revisión 2026-09-13 |
| Responsable | José valida el reporte de sombra; técnico: asistente | José 2026-09-13 |
| Capacidad | VPS actual (2 CPU, 7,8 GB, ~3,4 GB libres); ampliación futura sin fecha | José 2026-09-13 |

## Presupuesto de recursos

| Proceso | RAM límite | CPU | Notas |
|---|---|---|---|
| PostgreSQL 18 (instalado en P0) | 768 MB | 0,75 | `shared_buffers` 192 MB; datos en volumen propio |
| API v2 (sombra) | 256 MB | 0,25 | sólo health, auth y lectura de estado |
| Worker | 192 MB | 0,2 | reclama y ejecuta mensajes; sin escritores remotos |
| Scheduler | 96 MB | 0,1 | sólo encola trabajos periódicos; no ejecuta efectos |
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

### 2. Condición de entrada: P0 cerrado
- PostgreSQL vacío, WAL archivado a B2, base backups verificados y PITR medido pertenecen a P0
  (`deliveries/PLAT-0-gate0.md`). P1 no instala ni configura la base: aplica migraciones sobre ella.
- **Aceptación:** la ficha de P0 registra RPO/RTO medidos y el vigía de WAL activo.

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
- Tres servicios separados sobre la misma imagen: API, worker (reclama y ejecuta) y scheduler (sólo
  encola periódicos, nunca ejecuta efectos). Caída de uno no detiene a los otros; cada uno con su
  healthcheck. Nada queda `pending` fuera del alcance del scheduler (`parked` explícito).
- **Aceptación:** tests de concurrencia (dos workers no toman el mismo mensaje), caída entre efecto y
  confirmación, reintentos 403/408/429/5xx con fixtures, DLQ visible en `/api/v2/incidents`.

### 5. Autenticación con passkeys y roles
- WebAuthn (passkeys) para catálogo y administración, códigos de recuperación de un solo uso,
  reautenticación reciente para acciones de riesgo; operador puede seguir con contraseña.
- Roles base operador, catálogo, administración + capacidades finas; migración de usuarios del
  legado sin sus contraseñas (se enrolan).
- **Aceptación en P1:** enrolamiento, login, reautenticación y recuperación verificados con
  autenticador virtual WebAuthn en tests (incluye autenticación cruzada simulada). Las passkeys quedan
  **desactivadas para uso real** (flag).
- **Condición para activarlas (P2):** con `qa-herramientas.fusionbikes.com.ar` en HTTPS, José prueba
  enrolamiento y login en iPhone, Mac/PC con Touch ID o Windows Hello, compu sin biometría con iPhone
  vía QR, y Android. Sin esa prueba no se activan.

### 6. Ingesta en sombra y reporte de diferencias
- **No bloqueante para el legado:** el webhook se responde y procesa exactamente como hoy. La copia al
  `inbox_messages` nuevo ocurre después, fuera de la transacción del legado, con timeout corto. Si
  PostgreSQL no está o falla, la copia se descarta con una métrica y **no** se reintenta desde el
  handler: el ACK a ML/Woo nunca depende de la base nueva.
- **Reparación por relectura externa:** un trabajo del scheduler relee periódicamente ML (órdenes y
  recursos notificados) y Woo (órdenes y productos modificados desde el último cursor) y encola en el
  inbox lo que falte. La fuente de conciliación es **la API remota**, no la base del legado ni la copia.
- Deduplicación por (cuenta, tópico, recurso, versión remota): una señal repetida o fuera de orden no
  duplica mensajes.
- Reporte diario para José: señales del legado, señales del núcleo, faltantes reparados por relectura,
  duplicados descartados, latencia, y copias descartadas por falla de la base nueva.
- **Aceptación:** con PostgreSQL detenido a propósito durante una prueba, el legado no cambia su
  respuesta ni su latencia y la relectura repara lo perdido; 7 días de sombra con 0 faltantes sin
  explicar y el reporte revisado por José.

## Riesgos y cómo se contienen

- **Memoria del VPS:** límites duros por contenedor y medición antes/después; si PostgreSQL empuja al
  legado, se baja `shared_buffers` antes de seguir.
- **Doble procesamiento:** la sombra nunca tiene credenciales de escritura de ML/Woo en esta etapa.
- **Claves perdidas:** sin la copia de José, un restore no puede leer PII cifrada; el paso 3 no se da
  por cerrado sin confirmar esa copia.
- **Alcance:** cualquier pantalla o migración de datos de negocio pertenece a P2+, no a este plan.

## Qué necesita José

1. Confirmar este plan corregido (y el presupuesto de RAM), después de que P0 quede cerrado.
2. Guardar fuera del VPS la clave de cifrado cuando se genere en el paso 3.
3. Revisar el reporte de sombra durante los 7 días del paso 6.
4. Cuando exista `qa-herramientas`, probar passkeys en sus dispositivos (condición para activarlas en P2).
