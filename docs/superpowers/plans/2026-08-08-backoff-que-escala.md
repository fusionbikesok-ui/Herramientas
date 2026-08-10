# Que el backoff de ML escale de verdad

Fecha: 2026-08-08
Rama: `worktree-backoff-escalada` (base `1eb9546`, master local — NO `origin/master`)

## Problema, con evidencia

Medido sobre 4000 líneas del log del proceso vivo:

| Nivel de backoff | Veces alcanzado |
|---|---|
| nivel 0 (60 s) | **498** |
| nivel 1 (120 s) | 256 |
| nivel 2 (300 s) | 33 |
| nivel 3 (600 s, el techo) | **0** |

Con **493** líneas de `cooldown finalizado — backoff reseteado`. Casi 800 rechazos reales de ML
en esa ventana y el freno nunca llegó al techo.

`BACKOFF_ESCALONES_MS = [60_000, 120_000, 300_000, 600_000]` existe para romper el bucle
auto-sostenido del incidente del 2026-08-04 (16 h sin sync). No lo rompe nunca, porque
`_resetBackoff` (`lib/mlClient.js:239`) hace `_backoffNivel = -1` ante **cualquier** llamada
exitosa no manual. Como los 9 crons pegan a recursos distintos, siempre hay algún 200 barato
entre dos 429: **un éxito en un endpoint liviano le levanta el freno a uno caro**, y volvemos
al piso de 60 s indefinidamente.

Consecuencia medida hoy, después de desplegar `1eb9546`: la **primera** llamada de cada corrida
ya recibe 429 (`GET /shipments/47513256853`, 429 real, sin cooldown previo). Nunca salimos del
pozo, así que la caché `ml_shipment_estado` que introdujo `1eb9546` no consigue una sola ventana
limpia para poblarse y se queda en 0 filas. El arreglo anterior es correcto pero no puede
arrancar mientras esto siga.

## Por qué "decaer de a un escalón por éxito" NO alcanza

Es la solución que parece obvia y hay que descartarla explícitamente: con ~1 éxito por cada 429,
decaer un escalón por éxito nos deja oscilando entre nivel 0 y nivel 1 igual que hoy. El
problema no es el tamaño del paso: es que **el nivel se maneja por eventos de éxito en vez de
por tiempo transcurrido sin problemas**.

## Diseño

Separar las dos cosas que hoy hace `_resetBackoff`:

1. **Cerrar la ventana de cooldown** ante un éxito no manual: sí, se mantiene. Un 200 prueba que
   ML volvió a atendernos *ahora*, así que no tiene sentido seguir bloqueando llamadas.
   `_cooldownHasta = 0`.
2. **Bajar el nivel de escalada:** ya NO por éxito. El nivel solo decae por tiempo, que es lo
   que ya hace `_decaimientoPorGracia` (`GRACIA_DECAIMIENTO_MS = 15 min` desde el vencimiento
   del último cooldown). Así, 429 sostenidos escalan de forma monótona hasta el techo de 10 min
   —que es justamente el aire que ML necesita para perdonarnos— y el nivel solo vuelve a bajar
   tras un rato genuinamente tranquilo.

**Archivo:** `lib/mlClient.js` (`_resetBackoff` ~239, `_decaimientoPorGracia` ~248, y el punto
de llamada ~597).

Puntos a resolver con cuidado durante la implementación:

- `_decaimientoPorGracia` hoy exige `_cooldownHasta !== 0` para decaer. Si el éxito pone
  `_cooldownHasta = 0`, esa condición deja de cumplirse y **el nivel no decaería nunca**: se
  pasaría del problema actual al problema opuesto (quedarnos frenados al techo para siempre).
  Hay que llevar la marca de tiempo en una variable propia (p. ej. `_ultimoCooldownVencidoEn`)
  en lugar de deducirla de `_cooldownHasta`.
- El log `cooldown finalizado — backoff reseteado` pasa a mentir: ya no se resetea. Que diga el
  nivel en el que queda.
- `estadoCooldownMl()` expone `nivel`; verificar que lo que muestre siga siendo cierto y útil
  para `/api/sync/estado`.

## Criterios de aceptación

1. **El que importa (hoy falla):** con 429 alternados con éxitos —el patrón real de los 9 crons—
   el nivel escala monótonamente hasta el techo. Concretamente: 429, éxito, 429, éxito, 429,
   éxito, 429 debe terminar en **nivel 3 (600 s)**, no oscilando en 0/1. Este test tiene que
   ponerse rojo si se revierte el cambio.
2. Un éxito sigue cerrando la ventana de cooldown: tras un 200 no manual, `estadoCooldownMl()`
   devuelve `activo:false` y las llamadas automáticas vuelven a salir.
3. Tras `GRACIA_DECAIMIENTO_MS` sin cooldown nuevo, el nivel vuelve a -1 y el siguiente 429
   arranca otra vez en 60 s. **Sin esto el cambio es peor que la enfermedad.**
4. Una llamada **manual** exitosa sigue sin resetear nada (regla ya existente y deliberada, ver
   el comentario en el punto de llamada).

Todos con mutation testing: revertir la línea protegida y confirmar rojo.

## Fuera de alcance

El techo de 600 s se deja como está. Si tras esto ML todavía no nos suelta, el siguiente hilo es
subir el techo, no volver a tocar la escalada.

## Regla de despliegue

`npm test` verde + revisor OK + auditor 🟢. No toca `public/`: sin `disenador-ux`, `disenador-ui`
ni `probador-e2e`. Merge y `pm2 restart` los autoriza el usuario.
