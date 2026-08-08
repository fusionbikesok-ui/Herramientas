# Cortar la ráfaga de llamadas a ML que congela la reconciliación

Fecha: 2026-08-08
Rama: `worktree-rafaga-ml` (base `dd7cbca`, master local — NO `origin/master`, que está 4 commits atrás)

## Problema, con evidencia

El barrido de `reconciliarStockMl` lleva 216 corridas seguidas terminando en
`150 de 150 publicaciones del lote quedaron sin dato de ML`, con el cursor clavado en
`MLA2113591132|`. Consecuencia visible para el negocio: el casco Starvos
(`MLA3100995880`, `MLA3101055492`, `MLA3101044322`) sigue con stock desincronizado y
3 de sus 4 publicaciones cacheadas como `paused_by_seller` desde el 2026-07-30, cuando
en ML están `active`.

La causa NO es ML bloqueándonos ni el diseño de la reconciliación. Tres evidencias
independientes:

1. **Experimento controlado** (`probe-variantes`): la MISMA llamada (multiget de 20 ids
   con `variations`) dio 429 y, 140 s después, 200 en 189 ms. Un multiget de 5 ids también
   dio 200. No es el tamaño del lote ni el atributo — es el momento.
2. **Serie temporal** (sonda cada 30 s): `12:24` 200, `12:24` 200, y de `12:25` a `12:29`
   nueve rechazos consecutivos. El minuto `:25` es el del cron `syncPedidosCache`.
3. **Secuencia en el log**, repetida ciclo tras ciclo:
   ```
   [ML] 429 real de ML (GET /shipments/47510171873) — cooldown activado por 60s (nivel 0)
   pendientesMl: 9 fallo(s) de /shipments al listar pendientes ML
   syncPedidosCache: listado ML no confiable esta corrida, se omite la poda
   [ML] 429 real de ML (GET /items?ids=<20 ids>) — cooldown activado por 120s (nivel 1)
   reconciliarStockMl: 150 de 150 publicaciones del lote quedaron sin dato de ML
   ```

### La cadena

1. `pendientesMl` (`routes/preparacion.js:1137`) pagina `/orders/search` sobre 30 días
   (**137 órdenes**) y después hace **un `GET /shipments/{id}` por cada una en un bucle
   cerrado, sin ninguna pausa** (`routes/preparacion.js:1181`). Descontando 29
   preparaciones completadas son ~108 llamadas de golpe, cada 10 minutos:
   **~15.500 llamadas a ML por día** para descubrir ~34 pendientes.
2. `lib/mlRateLimiter.js:35` arranca cada bucket **lleno con un minuto entero de cupo**
   (425 lecturas). Respeta el promedio pero permite que las 425 salgan sin separación
   alguna. ML no mide promedios: castiga la ráfaga.
3. La penalización de ML dura **más de 4 minutos** (medido `:25`→`:29`).
4. `reconciliarStockMl` corre en `:09/:19/:29`, dentro de esa ventana. Su **primer** chunk
   se come el 429, el cooldown global convierte los 7 chunks restantes en 429 sintéticos,
   y se pierde el lote entero de 150. El cursor no avanza.

Segundo damnificado: `syncPedidosCache` se rompe a sí mismo — termina en
`listado ML no confiable, se omite la poda` en cada corrida, así que la caché de pedidos
nunca poda.

## Decisión del usuario

Se arreglan **las dos capas**: recortar las llamadas Y ponerle techo de ráfaga al
limitador compartido. La primera baja el gasto de hoy; la segunda impide que el próximo
bucle que alguien escriba reintroduzca el problema.

---

## Paso 1 — `pendientesMl` deja de re-consultar envíos ya despachados

**Archivos:** `routes/preparacion.js` (~1137-1211), migración nueva en `migrations/`.

Un envío que ya salió no vuelve nunca a `ready_to_ship`. Hoy lo re-preguntamos cada 10
minutos para siempre.

- Tabla nueva `ml_shipment_estado(shipment_id TEXT PRIMARY KEY, status TEXT NOT NULL,
  logistic_type TEXT, actualizado_en TEXT NOT NULL)`.
- Estados **terminales**: `shipped`, `delivered`, `cancelled` (`not_delivered` queda
  afuera: es una visita fallida con reintento, no un estado final — para envíos locales el
  envío puede volver a `ready_to_ship`). Al leer un shipment con `status` presente se
  guarda su status; si el guardado es terminal y reciente (< 7 días), en las corridas
  siguientes se **saltea el GET**. Pasados 7 días se vuelve a verificar contra ML.
- Un salteo **no** es un fallo: no incrementa `fallosShipment` y no debe ensuciar
  `confiable`. Un envío terminal tampoco es `ready_to_ship`, así que queda fuera de
  `pendientes` igual que hoy — la garantía se sostiene, pero el resultado observable SÍ
  puede cambiar en un sentido puntual: antes, un GET de shipment terminal que se comía un
  429 dejaba `confiable=false` y la poda no corría esa vez; ahora ese GET ya no existe para
  los que están cacheados como terminales recientes, así que la poda queda disponible con
  más frecuencia. La garantía fail-closed no se afloja — solo se da con más chances.
- Los estados no terminales (`pending`, `handling`, `ready_to_ship`) se siguen
  consultando en cada corrida, que es lo único que puede cambiar.
- Un 200 sin `status` en el body no es un éxito válido: la columna es `NOT NULL` y
  cachearlo tiraría `SqliteError`. Se trata igual que un fallo de red (`fallosShipment++`)
  y nunca se cachea.

**Criterio de aceptación:** con 137 órdenes de las que 100 tienen envío terminal cacheado
y reciente (< 7 días), la corrida hace 37 GET de shipment en vez de 108, y devuelve el
mismo `pendientes` que la implementación actual. `confiable` mantiene la misma garantía
fail-closed (nunca poda con datos parciales o fallidos), pero YA NO es necesariamente
idéntico corrida a corrida: los GET que se saltearon por estado terminal ya no pueden
comerse un 429, así que `confiable` queda en `true` con más frecuencia que antes (la poda
se vuelve más disponible, nunca menos segura).

## Paso 2 — Techo de ráfaga en el limitador compartido

**Archivo:** `lib/mlRateLimiter.js`.

Hoy *capacidad* y *ritmo* son el mismo número. Separarlos:

- El refill sigue siendo `cupoEfectivo(recurso)` por minuto — **el promedio no cambia, no
  se recorta throughput**.
- Se acota el tope de acumulación a una ventana corta:
  `RAFAGA_MAX_MS = 3000` → techo `Math.max(1, Math.ceil(cupo * 3000 / 60000))`.
  Para `lectura` (425 rpm) son ~22 llamadas seguidas; después el bucle queda paceado a
  ~5/s en vez de salir entero de golpe (con `PASO_ESPERA_MS=100`, cada token liberado
  cuesta en promedio ~2 pasos de espera, no 1 — de ahí ~200 ms por llamada, no ~140 ms).
- El bucket **arranca en el techo de ráfaga**, no lleno.

Verificar que ningún bucle real se quede sin cupo: `reservarCupo` espera hasta 15 s
(automática). Un bucle de 108 llamadas paga ~200 ms de espera por llamada pasadas las
primeras 22 — muy por debajo del límite. `pushSkusPendientes` (120 escrituras) queda igual.

**Criterio de aceptación:** un test que pide 100 permisos seguidos de `lectura` comprueba
que las primeras ~22 salen sin espera y que el resto tarda al menos
`(100-22)/425*60000` ms en total; y que ninguna devuelve `false`.

## Fuera de alcance (deliberado)

`_resetBackoff` (`lib/mlClient.js:239`) borra el nivel de backoff ante **cualquier**
llamada exitosa, así que el cooldown nunca escala más allá de nivel 1 y volvemos a
golpear cada ~3 minutos. Es real, pero con la ráfaga eliminada el cooldown debería dejar
de dispararse en régimen normal. Se deja anotado; si tras el despliegue siguen apareciendo
429, este es el próximo hilo.

## Regla de despliegue

`npm test` verde + revisor OK + auditor 🟢 antes de dar por cerrado. No toca `public/`,
así que no van `disenador-ux`, `disenador-ui` ni `probador-e2e`. El deploy a producción
lo hace el usuario a mano.
