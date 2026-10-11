# Plan: Fase D — pantalla única "Catálogo y vínculos"

Spec: `docs/superpowers/specs/2026-10-09-fase-d-catalogo-y-vinculos.md` (aprobada por José el 2026-10-09, revisada por
Codex gpt-6-sol high).

**Quién hace cada cosa:**
- Implementa la sesión worker, rama `feat/fase-d-catalogo-vinculos` desde `origin/master`.
- Revisa el coordinador. Gates: revisor (por tanda), probador-e2e (toca `public/`) y auditor-despliegue.
- El despliegue lleva backup y el OK de José en la sesión del worker. Las pantallas viejas se retiran ese mismo día.

**Entrega:** una sola, usable en sí misma (la pantalla nueva reemplaza a las viejas el mismo día). Los pasos son
tandas internas de revisión, no entregas.

**Qué se prueba:** en cada paso, primero el test que falla y después el código. Se corren solo los archivos
afectados; la suite completa no hace falta salvo que José la pida.

**Qué dispara cada flujo:** el operador o José desde la pantalla; la ejecución en ML la hace el worker de
operaciones de Identidad (`procesarOperacionesIdentidad`, cron existente); la liberación automática de retenidas
sigue por su cron.

## Paso 0. Requisito: vincular publicaciones pausadas

- Es el PR que ya está haciendo el worker: `decidirCasoIdentidad` "vincular", con ML que ya tiene el SKU objetivo,
  actualiza el vínculo local y cierra el caso, aunque la publicación esté pausada.
- **Aceptación:** mergeado antes del paso 5.

## Paso 1. Ventas por publicación (cola)

- **Archivos:** migración `122_gestion_pedido_items_ml_key.sql` (columna `ml_key` + índice), `lib/gestionPedidos.js`
  (persistir `ml_key` desde `lib/modelos/ordenVenta.js`), una función `plataEnJuego(db)` en
  `lib/catalogoVinculos.js` (nuevo), tests.
- **Completar 30 días:** se corre una vez la reconciliación existente de 30 días después del despliegue (paso de
  despliegue, con OK de José).
- **Aceptación:** dos publicaciones con el mismo SKU suman solo sus propias ventas; sin producto Woo o sin stock da 0;
  empate → caso más antiguo primero.

## Paso 2. Matriz por atributo

- **Archivos:** `lib/catalogoVinculos.js` → `matrizAtributos(db, clave, sku)`; reutiliza la extracción y
  normalización de `lib/contradiccionTitulo.js`; tests.
- **Filas:** título, SKU, GTIN, color, talle, rodado, transmisión, velocidades; estado por fila rojo / ámbar / verde
  / gris con texto.
- **Aceptación:** el rojo coincide exactamente con `contradiccionDeClave` (test con los mismos fixtures); GTIN se
  compara aparte; un campo faltante de un lado da ámbar.

## Paso 3. Contratos nuevos de Identidad (admin)

- **Archivos:** `lib/identidadProductos.js`, `routes/identidadProductos.js`, migración si hace falta columna de
  override, tests.
- **Confirmar igual:** decisión con `override` + motivo; la saga (`:1861-1864`) la respeta solo para esa clave y SKU.
- **Destrabar:** transición `intervencion → pendiente` con motivo y evento; se reevalúa con la Fase C.
- **Link de pago vs no sincronizar:** "link de pago" = `omitir` de hoy (ignora ventas). "No sincronizar" = marca
  nueva con variante (a)/(b)/(c); sus ventas se retienen (`routes/sync.js:780-785` y `retenerPedidoMl`).
- **Variante (b):** operación durable `pausar` en la cola de Identidad, sin depender de Guardia; alcance (variaciones
  del ítem) en la respuesta para confirmar.
- **Deshacer:** cancelar la operación solo si está pendiente o en sombra; si no, `INVALID_STATE`.
- **Permisos en el router:** admin para confirmar igual, destrabar, link de pago, revertir (c), reintentar,
  confirmar impacto.
- **Aceptación:**
  - un operador recibe 403 en cada acción de admin;
  - destrabar con contradicción vigente no libera el stock;
  - una venta de "no sincronizar" queda retenida y una de "link de pago" se ignora;
  - deshacer una operación ya empezada da `INVALID_STATE`.

## Paso 4. API de la pantalla

- **Archivos:** `routes/catalogoVinculos.js` (nuevo, montado en `server.js`), `lib/permisos.js`, tests.
- **Endpoints:**
  - `GET cola`, con orden por `plataEnJuego` y filtros;
  - `GET casos/:id`, con la matriz, lo observado en ML y lo que manda la regla (`frenaIdentidad`);
  - `GET estado`, con los indicadores de salud de Identidad;
  - `GET retenidas` y `POST retenidas/:id/liberar`, que reusan `liberarPedidoRetenido` con el permiso actual.
- **Escrituras:** delegan en las funciones de Identidad, sin duplicar lógica. El contrato es `operation_id` en el
  cuerpo.
- **Aceptación:** cada indicador de salud de la pantalla vieja de Identidad tiene su campo en `GET estado`.

## Paso 5. Pantalla

- **Diseño:** antes de codificar, `disenador-ui` define la presentación con los tokens de `public/lib/theme.css`.
- **Implementación:** `hard-worker-frontend`.
- **Archivos:** `public/catalogo-vinculos/`.
- **Pestañas:** Casos (con la franja Estado), Vínculos (con buscador y filtros del Matcher, revincular, revertir y
  Códigos en conflicto por GTIN), Ejecución y Retenidas.
- **Comportamiento:** teclado según R6, estados y copy según R5, y sin atajos en celular.
- **Aceptación:**
  - el recorrido E2E de la spec (criterio 12), con operador y con admin, en escritorio y a 360 px;
  - el probador-e2e lo valida contra un entorno con base anonimizada.

## Paso 6. Retiro de las viejas

- **Redirecciones:** `public/matcher/`, `public/identidad-productos/`, `public/guardia-ml/` y
  `public/bandeja-identidad/` redirigen a la pantalla nueva.
- **Inicio:** en `public/home/index.html` se sacan las tarjetas y chips viejos y se agrega "Catálogo y vínculos".
- **Endpoints:** quedan vivos los que usan otros consumidores (`POST /api/matcher/decisiones`, `push-skus-pendientes*`
  y `/api/v1/identidad-productos`).
- **Checklist:** se recorre la tabla de inventario de la spec, fila por fila, y se adjunta al PR.
- **Aceptación:**
  - ninguna URL vieja da 404;
  - ninguna acción del inventario queda sin equivalente o sin descarte explícito.

## Paso 7. Memoria y PR

- **Memoria:** `docs/memory/modules/` (el módulo de integración ML-Woo y el de la UI que corresponda) y una línea en
  `active.md`.
- **PR:** un solo PR a `master`, con los resultados de los tests dirigidos, el reporte del probador-e2e y el checklist
  del paso 6.

## Despliegue (con OK de José)

1. Backup de la base y migraciones 122 y siguientes.
2. Traer el código. Producción no corre `master`: José decide cómo traerlo, como en la Fase C.
3. `pm2 restart`.
4. Reconciliación de pedidos de 30 días, para completar `ml_key`.
5. Verificar con José la cola, un vínculo real aplicado en ML ("Aplicada") y una retenida liberada.

**Para volver atrás:** revertir el código y reiniciar, con lo que vuelven las pantallas viejas. Las migraciones son
aditivas.
