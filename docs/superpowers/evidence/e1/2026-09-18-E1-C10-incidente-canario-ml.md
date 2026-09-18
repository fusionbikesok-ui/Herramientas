# E1 C10 — el canario de ML descartó todo por una cuenta sin configurar (2026-09-17/18)

## Qué pasó

| Hora UTC | Hecho |
|---|---|
| 2026-09-17 16:38:30 | Se enciende la copia de sombra de ML al 100 % con tope de 60 rpm, junto a Woo |
| 16:41:23 | Primer recibo de ML descartado; **todos** los siguientes también |
| 20:40:01 | Dos recibos de ML quedan como `platform_timeout` sin importar |
| 21:40:33 | Incidente crítico `perdidas_sin_importar` (pérdida sin importar de más de 1 h) |
| 21:40:35 | El monitor aplica el aborto del SOP: apaga la copia y termina. Legado 200 |
| 2026-09-18 03:27 | Se siembra la cuenta de ML y sus 6 corrientes; se corrige la configuración |
| 03:48:30 | Copia reencendida (Woo + ML). Legado 200 en 2 s |

Balance de las cinco horas: **347 recibos de ML descartados**, 59 excluidos por tópico no soportado, 2 pérdidas
sin importar, y 156 recibos de Woo copiados sin un solo descarte. El legado respondió 200 en las 61 mediciones y
la operación del negocio no se vio afectada: la sombra nunca condiciona el ACK.

## Causa

La cuenta de Mercado Libre **no estaba en `SENALES_CUENTAS`** de la plataforma, y la API de señales toma la
cuenta de esa configuración, nunca del cliente (`plataforma/src/api/senales.ts`). Sin la cuenta, cada señal de ML
recibía 409 `channel_topic_mismatch`, y el legado marcaba el recibo como descartado. Tampoco estaba en el
registro de cuentas del worker (`keyring/registro.json`), que además exige `seller_id` para ML.

Encender el canario de ML exigía tres pasos y sólo se hizo uno: los flags del legado sí, la configuración de la
plataforma y el registro del worker no.

## Qué se corrigió en producción

- `core.channel_accounts` tiene la cuenta `mercadolibre` y `integrations.sembrar_corrientes` creó sus 6
  corrientes (10 en total con Woo).
- `SENALES_CUENTAS` incluye las dos cuentas; `keyring/registro.json` incluye ML con `seller_id` y transporte
  `gateway`. Backups en `/root/plataforma-env-backup-20260918T032716Z` y `/root/registro-backup-20260918T032716Z`.
- Imagen de la plataforma reconstruida y api, worker y scheduler recreados. `/api/v2/health` ok en los cuatro
  componentes; el worker registra `cuentas=2 corrientes=10`.

## Qué se corrigió en el código

| Cambio | Commit | Por qué |
|---|---|---|
| Un 409 se etiqueta `cuenta_no_configurada`; un 400 sigue siendo `invalid_resource` | `0fc9b6c` | "recurso inválido" apuntaba al dato y escondía que el problema era nuestra configuración |
| El monitor avisa cuando un canal descarta más de lo que copia | `657431f` | El caso se veía en la primera medición, no a las 5 h |
| El barrido de pérdidas reimporta esa razón y la plataforma la acepta | `763b1e4` | Sin eso, los 347 recibos quedaban perdidos para siempre |
| Un canal sin configurar no bloquea la recuperación de los otros; la alerta durable cuenta la razón nueva; el aviso del monitor compara la ventana entre mediciones y no el acumulado | `dbc12f5` | Los tres salieron de la revisión externa del propio arreglo (ver abajo) |

## Revisión externa del arreglo

Codex (sólo lectura) revisó el arreglo y encontró tres problemas críticos, los tres ciertos y los tres
corregidos en `dbc12f5`:

1. **Detener la tanda en el primer `cuenta_no_configurada` bloqueaba pérdidas de otros canales.** Una fila vieja
   de ML habría impedido importar pérdidas nuevas de Woo en cada vuelta. Ahora se saltea sólo ese canal.
2. **La alerta durable no contaba la razón nueva**, así que podía informar cero pérdidas pendientes habiendo
   descartes por configuración: nadie se habría enterado.
3. **El aviso del monitor comparaba acumulados**, con lo que después de mil copias sanas una caída total de cien
   descartes no alertaba nunca. Ahora compara la ventana entre dos mediciones, con un piso de 5.

Quedan anotados y **no corregidos** (hallazgos de menor gravedad de esa misma revisión):

- Un 409 también puede venir de un tópico de otro canal o de un UUID configurado que no existe en la base; todos
  quedan bajo la misma etiqueta. Son todos problemas de configuración nuestra, así que la etiqueta no engaña,
  pero no los distingue.
- `SENALES_CUENTAS` y el registro del worker se leen por separado y nadie valida que coincidan: una cuenta sólo
  en la configuración es aceptada por la API y nunca consumida por el worker. Es la misma clase de error que
  causó este incidente.
- El evento de auditoría `shadow.loss_imported` no tiene restricción de unicidad: dos importadores concurrentes
  podrían duplicarlo. La señal sí se deduplica por fingerprint.
- Las listas de tópicos soportados están duplicadas en cuatro lugares y pueden divergir sin que el arranque falle.

## Lección

Encender un canal de la copia de sombra no es un flag: son tres piezas de configuración en dos sistemas. Falta
una verificación previa que las contraste antes de encender, y es lo que habría evitado estas cinco horas.
