# E2 tramo 1 — modelos, variantes y claves externas (diseño)

**Fecha:** 2026-09-18 · **Estado:** diseño, sin implementar · **Entrega:** E2, tramo 1 de 3
**Ficha:** `docs/superpowers/deliveries/E2-catalogo-modelo-importacion.md` · **Depende de:** E1 (sus barridos y su inbox)

## 1. Por qué este tramo primero

E2 se parte en tres tramos por valor, cada uno usable solo (decisión de José, 2026-09-18):

| Tramo | Contenido | Qué habilita solo |
|---|---|---|
| **T1** | modelos, variantes vendibles, representaciones en Woo y ML, identificadores y el cruce Woo↔ML | saber, en la base canónica, qué se vende, dónde y con qué SKU, y qué falta decidir |
| T2 | taxonomía, marcas, colecciones y atributos | búsqueda y filtros sobre el catálogo canónico |
| T3 | imágenes y composiciones de packs y kits | fichas completas y el stock de kits |

## 2. Línea base (2026-09-18, sólo lectura, commit `6eab8d4`)

| Dato | Valor |
|---|---|
| `data/fusion.sqlite` | 161.501.184 bytes, 164 tablas |
| `catalogo_cache` (Woo) | 5.235 filas |
| `ml_publicaciones_cache` | 6.969 filas activas o pausadas |
| Decisiones del matcher | 5.207: 1.774 `confirmar`, 1.057 `asignar`, 2.376 `omitir` |
| Publicaciones de ML con SKU de Woo | 2.794; **sin decisión**: ~1.800; con SKU que ya no existe en Woo: 1 |
| `identidad_casos` | 1.339: 1.212 verificados, 111 resueltos, 13 pendientes, 3 urgentes |
| Observaciones de E1 | `woo.products` 3.089 recursos; `ml.items` 271 (sólo los que cambiaron: cobertura parcial) |

## 3. Decisiones de José (2026-09-18)

| Tema | Decisión |
|---|---|
| Tramos | Tres, por valor (tabla de §1) |
| Fuente | Releer Woo y ML **desde el origen**, no desde los cachés del legado |
| Cómo se relee | **Proyectando desde lo que E1 ya lee** (camino A): una sola lectura del origen, varias proyecciones |
| Identidad sin resolver | Se importa como **caso visible**; nunca se adivina por nombre ni por GTIN |
| Cruce Woo↔ML | Las decisiones del matcher entran **como decisiones auditadas**, con quién y cuándo |
| Variante vendible | **Lo que está publicado en algún canal**, tenga o no SKU todavía |
| Variante sin SKU | Existe con el **SKU pendiente** y un caso abierto hasta que el matcher lo asigne; una vez puesto, el SKU no cambia |
| Publicaciones "omitidas" | Entran como **omitidas por decisión**, con un caso de revisión de **baja prioridad** (en el matcher hay de las dos: omitidas a propósito y "lo veo después") |
| Modelo de variaciones de ML | Cada publicación guarda si es del **modelo viejo** (variaciones con precio único) o del **nuevo** (`user_product_id`, cada variación es un ítem) |

### Choque con el plan maestro, resuelto

El plan maestro fija como invariante que toda variante tiene un SKU `FB-{ID_WOO}` obligatorio e inmutable. La
decisión de José dice que existe todo lo que se vende. Las dos se sostienen juntas así: **el SKU es obligatorio para
cerrar el caso de la variante, no para que la variante exista**, y sigue siendo inmutable una vez asignado. La ficha
de E2 y el plan maestro se actualizan con esta lectura cuando se apruebe el diseño.

## 4. Arquitectura

```
Woo / ML ──(barridos de E1, una sola lectura)──▶ integrations.inbox_messages (payload cifrado)
                                                        │
                                  proyector de catálogo (worker de la plataforma)
                                                        ▼
        catalog.product_models · catalog.sellable_variants · catalog.external_representations
        catalog.identity_cases · catalog.matcher_decisions (evidencia del legado)
                                                        │
                                   GET /api/v2/catalog/{models,variants,reconciliation}
```

- **El proyector corre en el worker**, que ya tiene el keyring de sobres para descifrar los payloads del inbox. No
  llama a Woo ni a ML: lee lo que E1 ya guardó.
- **Una única barrida completa de `ml.items`** al empezar, porque E1 sólo trae lo que cambió. Son ~7.000 ítems, unos
  350 pedidos multiget: al tope de 60 por minuto de la sombra, unos 6 minutos. Después, E1 mantiene todo al día.
- **Las decisiones del matcher** no están en Woo ni en ML: viven sólo en el legado. Se toman de una **instantánea de
  sólo lectura** de `sku_matcher_decisiones`, con su hash, y cada decisión entra con su evento de auditoría. Ésta es la
  única lectura del legado que hace E2, y queda declarada.

## 5. Modelo de datos (T1)

| Tabla | Qué representa | Reglas que la base hace cumplir |
|---|---|---|
| `catalog.product_models` | el producto como concepto: un padre variable de Woo, o un simple | nunca se vende; se archiva, no se borra |
| `catalog.sellable_variants` | lo que se vende | `sku` nulo mientras está pendiente; **único cuando no es nulo**; un trigger impide cambiarlo una vez puesto |
| `catalog.external_representations` | cada aparición en un canal: variación de Woo, ítem o variación de ML | `(canal, cuenta, recurso, variación)` único; `modelo_ml` en `clasico` / `user_product` / nulo para Woo |
| `catalog.matcher_decisions` | la evidencia importada del legado | append-only; guarda `accion`, `origen`, `confirmado_por`, `actualizado_en` y el hash de la instantánea |
| `catalog.identity_cases` | lo que falta decidir | tipos: `sku_pendiente`, `omitida_revisar` (baja prioridad), `sku_inexistente_en_woo`, `identidad_legado` (importados de `identidad_casos` pendientes y urgentes) |

**Cómo se arma una variante:**
- Una variación de Woo o un producto simple de Woo → una variante con su SKU `FB-{ID_WOO}`.
- El padre variable de Woo → sólo un modelo.
- Una publicación de ML con decisión `confirmar` o `asignar` → representación vinculada a la variante de ese SKU.
- Una publicación de ML sin decisión → **variante con SKU pendiente** más caso `sku_pendiente`.
- Una publicación de ML con `omitir` → representación **omitida por decisión**, sin variante, con caso `omitida_revisar`.
- Un SKU del matcher que ya no existe en Woo → caso `sku_inexistente_en_woo` (hoy: 1).

## 6. Interfaz

`GET /api/v2/catalog/models`, `/variants` y `/reconciliation`, sólo lectura, paginados por cursor, con errores
`{code,message,correlation_id,details?}` y autorización por capacidad. `/reconciliation` devuelve el universo
clasificado: cuántas variantes con SKU, pendientes, omitidas, casos por tipo, y el hash del cruce.

## 7. Qué se considera terminado (ficha de E2)

- **100 % del universo clasificado**: cada publicación y cada producto de Woo queda como importado o como caso con
  causa. Nada se descarta en silencio.
- **Importación repetible e idempotente**: correrla dos veces da el mismo hash.
- **Cruce íntegro**: toda decisión confirmada del matcher tiene su representación, y viceversa.
- `npm run test:e2` existe, falla si falta un escenario, y cubre: restricciones SQL, importación repetida, padre no
  vendible, SKU inmutable, variante con SKU pendiente, omitida con caso, y el SKU inexistente en Woo.

## 8. Despliegue y reversión

Sólo lectura: el proyector escribe únicamente en `catalog.*` y no hay ningún escritor remoto. Se comparan conteos,
relaciones y hashes durante 7 días. La reversión es apagar el proyector y la API de catálogo, conservando el esquema.

## 9. Preguntas que quedan para el plan

1. Cuándo correr la barrida completa de `ml.items` (horario con poca venta, por la cuota).
2. Si los casos de identidad del legado se migran una vez o se sincronizan hasta que el legado deje de usarse.
