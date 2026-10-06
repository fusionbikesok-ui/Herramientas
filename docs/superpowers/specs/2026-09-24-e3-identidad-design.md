# E3 — Identidad y matcher único en sombra: diseño

**Fecha:** 2026-09-24 · **Ficha:** `docs/superpowers/deliveries/E3-identidad-matcher-sombra.md` ·
**Evidencia:** `docs/superpowers/evidence/e3/2026-09-24-E3-medicion-motor.md` · **Revisiones:** Codex x2 (enfoque).

## 1. Qué resuelve y para quién

José tiene **5.361 casos de identidad abiertos**, que nadie atiende: 2.227 `omitida_revisar`, 2.098 `sku_pendiente`, 500 `user_product_divergente` y el resto.
Hoy decide publicación por publicación en la herramienta del legado (matcher ML↔Woo). El motor del legado tiene estos números:
- acierta el primer candidato el **53 %** de las veces;
- tiene el correcto entre los 3 primeros el **82 %** de las veces;
- en el **30 %** de los casos pone primero uno incorrecto con puntaje ≥0,8.

Por eso su puntaje no sirve para decidir solo.

E3 entrega:
1. una **bandeja** donde cada caso llega con 3 candidatos explicados, y decidir es elegir uno;
2. un **motor único** en la plataforma que sólo decide solo por SKU exacto y único, verificado en el momento;
3. un **camino medido** para dejar de depender del matcher del legado.

**No incluye:** escribir en ML o Woo (cargar SKU en ML es E4), corregir los 39 SKU, ni que Gemini decida.

## 2. Decisiones del dueño (José, 2026-09-24)

| # | Decisión |
|---|---|
| D1 | **Revisada el 2026-09-24.** Primero se había decidido que mandara el legado durante la sombra. José aclaró que la herramienta del legado **no funciona**: en 5 días registró 56 decisiones fuera de la copia inicial, y no está verificado que alguna fuera de identidad. Esa autoridad existía sólo de nombre. Queda así: **las decisiones humanas de la bandeja se aplican desde el primer día.** Las 5.207 decisiones copiadas del legado quedan como historia y valen salvo que José decida otra cosa en la bandeja. La herramienta del legado deja de usarse para identidad. |
| D2 | **7 días de calibración** del motor contra las decisiones reales de José en la bandeja. *Modifica la ficha*, que pedía ≥7 días de sombra sin escritor: acá el escritor humano actúa desde el día 1, y lo que queda en sombra es sólo el **motor automático**. |
| D3 | La única automatización, el auto-vínculo por SKU exacto, pasa por un **día de canario** (§7) antes de quedar encendida. |
| D4 | Antes de auto-vincular, **se relee la publicación en ML**. Si cambió el SKU, el formato o el pack, el caso va a la bandeja. |
| D5 | Las **17 omitidas** cuyo SKU hoy coincide exacto van a la bandeja como «decisión vieja vs SKU exacto». Nunca se auto-vinculan. |
| D6 | Umbral del canario: **cero errores**, con los errores clasificados como en §7.3. |
| D7 | Gemini (API gratuita, **misma clave que Recepción** hasta que exista una propia) sólo genera candidatos a partir de atributos, con tope diario de consultas. Si no mejora el top-3 medido, se descarta. |

## 3. Autoridad

Hay un solo escritor de `variant_id` en la plataforma: **el proyector** (`vincularMl`, `plataforma/src/catalogo/aplicar.ts`), bajo `bloquearDecisiones`.

**Orden de consulta de `vincularMl`:**
1. Decisión **humana** vigente de E3 (`identity_decisions`, origen `humano`).
2. Decisión copiada del **legado** (`matcher_decisions`), como historia.
3. Sólo con el flag `E3_AUTO_SKU` o durante el canario: decisión E3 `auto_sku`.
4. Si no hay ninguna, `sku_pendiente`.

**Qué pasa con la herramienta del legado:**
- Deja de usarse para identidad.
- Si igual registra una decisión nueva sobre una clave que ya tiene decisión humana de E3, **no la pisa**: manda la humana de E3 y se abre un caso `decision_en_conflicto` en la bandeja.
- Si registra una decisión sobre una clave sin decisión de E3, se aplica como hoy.

**Efecto de una decisión humana en la bandeja:** se aplica en la misma transacción. Se registra la decisión, y el proyector re-vincula la publicación bajo `bloquearDecisiones`. En Woo y ML no se escribe nada.

**Rollback:**
- se apaga el flag `E3_BANDEJA`: la bandeja pasa a sólo lectura y `vincularMl` vuelve a consultar sólo al legado;
- el auto-SKU se apaga con su propio flag;
- las decisiones y la evidencia se conservan;
- revertir un vínculo es una decisión compensatoria nueva, nunca un borrado.

## 4. Modelo de datos (migración nueva, `plataforma/migrations/00NN_identidad.sql`)

Se reusa `catalog.identity_cases` tal como está: su objeto es `variant_id`, `representation_id` o `model_id`, y los tipos ya existen. Se agregan:

- **`catalog.identity_decisions`** (append-only, sin UPDATE ni DELETE para el rol de la app):
  - columnas: `id`, `company_id`, `case_id`, clave (`channel_account_id`, `recurso`, `variacion_normalizada`), `eleccion` (`vincular`/`omitir`/`mantener_omision`/`sin_candidato`), `variant_id`, `origen` (`humano`/`auto_sku`), `actor`, `motivo`, `efecto` (`sombra`/`aplicar`), `engine_version`, `hash_payload_ml`, `expected_version`, `creado_en`, `supersede_a`;
  - una decisión **vigente** por clave y efecto, con índice único parcial sobre la última no superada;
  - las decisiones `humano` son siempre `aplicar`, y las `auto_sku` son `sombra` hasta que el canario pasa (§7).
- **Versión del caso:** columna `version int` en `identity_cases`. Cada decisión exige `expected_version` y, si no coincide, responde 409 sin efecto parcial.
- **`catalog.identity_candidates`:**
  - columnas: `case_id`, `run_id`, `variant_id`, `rank`, `puntaje`, `explicacion jsonb`, `fuentes` (`motor`/`gemini`), `engine_version`;
  - se retienen por corrida y la bandeja muestra la última.
- **`catalog.identity_evidence`:**
  - columnas: `case_id`, `fuente` (`ml`/`woo`/`plataforma`), `observado_en`, `hash`, `campos jsonb`;
  - la relectura de D4 queda acá.
- **`catalog.format_observations`:**
  - columnas: clave ML, `version_remota`, `hash`, y los campos estructurales `variaciones`, `cantidad_pack`, `listing_type`, `catalog_listing`, `seller_sku`;
  - la base para detectar cambios de formato o pack (§8).
- **`catalog.e3_canario`:** el conjunto congelado (`clave`, `sku`, `variant_id` esperado, `resultado`), el inicio y el fin.

`vincularMl` lee `identity_decisions` además de `matcher_decisions`, en el orden de §3.

## 5. Motor (`plataforma/src/identidad/`)

- **Normalización del SKU** (versionada dentro de `engine_version`):
  - trim y mayúsculas;
  - los espacios internos no se tocan;
  - un SKU vacío o `null` nunca matchea.
- **Unicidad:** dentro de la empresa, sobre `sellable_variants` no archivadas.
- **Auto-vínculo** (en sombra hasta el canario, y aplicado sólo durante el canario o con `E3_AUTO_SKU`): el SKU normalizado de ML coincide con exactamente una variante, se cumplen las precondiciones de §6 y la clave no tiene una decisión humana vigente ni un `omitir` del legado.
- **Candidatos:**
  - se porta a TypeScript el algoritmo de `lib/matcherEngine.js`, con los arreglos de `fe8d1a42`: `ATRIBUTOS_NO_VARIANTE`, `normalizarGeneroNumero`, orden por `codigo_modelo_compartido` y `color_ok`;
  - el motor devuelve el top-N con una **explicación por candidato**: qué coincide (marca, modelo, talle, color, rodado, pack) y qué difiere;
  - el puntaje **no se muestra como confianza** hasta calibrarlo (§9).
- **Gemini (D7):**
  - extrae atributos de los títulos una vez por publicación y guarda el resultado junto con el modelo y el hash del prompt;
  - se usa para **ampliar** los candidatos: buscar variantes con marca y modelo iguales que el motor no trajo;
  - lotes de 30–50 títulos, de noche, con un tope diario (valor por defecto: 100 consultas);
  - si hay un 429, corta y sigue al día siguiente;
  - sin Gemini, el motor funciona igual.
- **Paridad con Recepción:** E3 no reemplaza todavía `lib/recepcionMatching.js`; eso queda anotado como deuda. Se mide la divergencia de los dos motores con la muestra.

## 6. Precondiciones de un auto-vínculo aplicado

En una sola transacción de aplicación:
1. **Relectura de ML** de la publicación, sin recurrir al payload guardado:
   - el SKU normalizado tiene que ser igual al del conjunto congelado;
   - los campos estructurales (`format_observations`) tienen que ser iguales a la última observación;
   - si la publicación está pausada, sigue siendo elegible; si está cerrada o eliminada, va a la bandeja.
2. **Relectura local** de la variante destino: existe, no está archivada, su SKU normalizado no cambió y sigue siendo el único.
3. Se registra la decisión con `hash_payload_ml` y `engine_version`, y el proyector aplica el vínculo bajo `bloquearDecisiones`.

**Política ante fallos de relectura:**

| Resultado | Acción | ¿Cuenta como error del canario? |
|---|---|---|
| 5xx, timeout o 429 | reintento con backoff y jitter (3 intentos) → `parked` | sí, si sigue `parked` al cierre del día |
| 404, cerrada o eliminada | a la bandeja, con evidencia | no |
| cambió el SKU, el formato o el pack | a la bandeja como `intervention` | no (es el sistema funcionando) |
| respuesta incompleta | `parked` | sí, si sigue sin resolver |
| 401/403 | **se aborta el canario** y se apaga el flag | sí |

## 7. Canario y comparación

1. **Conjunto congelado:** al arrancar, se guardan en `e3_canario` todos los `sku_pendiente` elegibles. Hoy son unos 146; los 17 de D5 quedan excluidos. Los casos que aparezcan durante el día no entran.
2. **Replay previo, obligatorio:** antes del canario se corre el motor sobre:
   - la muestra fija de 299;
   - todas las decisiones de José de los 7 días de calibración.

   Este replay compensa D2: el día de canario es un gate operativo, no equivale a 7 días de evidencia.
3. **Clasificación de discrepancias (D6):**
   - **Error:** E3 vinculó por SKU y José lo corrige a otra variante.
   - **Error:** en sombra, un `auto_sku` difiere de lo que José decidió para esa misma clave (se mide durante los 7 días).
   - **Error:** una relectura `parked` que sigue sin resolver al cierre.
   - **No es error:** una decisión del legado o de José que coincide con el `auto_sku` (redundante).
   - **No es error:** un cambio remoto posterior al vínculo, que se detecta como `intervention`.
   - **No es error:** una clave que dejó de ser única y fue a la bandeja sin vincularse.
4. **Resultado:** 0 errores → José autoriza encender `E3_AUTO_SKU`. Con uno o más errores → se analiza la causa, se corrige y se repite el día.

## 8. Máquina de estados del caso

```
unclassified ─classify→ actionable ─decide(humano)→ decided ─aplicado→ verified
      │               │                                 │
      │               └─auto_sku (canario o E3_AUTO_SKU, §6 ok)→ verified
      │               └─relectura falla→ parked ─reintento ok→ actionable
      └─sin datos→ parked
verified ─cambio SKU (misma variante inexistente)→ intervention
verified ─cambio formato/pack→ intervention (+ comando «pausar» parked para E4, no se ejecuta)
decided/verified ─decisión del legado distinta→ conflict (decision_en_conflicto)
intervention|conflict ─decide(humano)→ decided
cualquiera ─publicación archivada→ archived
```

Cada transición registra al actor, el motivo, el antes y el después, y el correlation_id. Una transición a `conflict` o `intervention` nunca cambia el vínculo por sí sola.

**Alertas:**
- Al pasar a `intervention` o `conflict` se genera una alerta en la bandeja de notificaciones que ya existe.
- Una alerta sin acuse en 24 h escala en el reporte diario.
- José definirá después el tiempo de respuesta por severidad. Los valores por defecto: `conflict` 24 h, `intervention` 48 h, el resto sin plazo.

## 9. Calibración

- **Denominador:** la muestra fija de 299, congelada en la evidencia de E3, más cada decisión humana de los 7 días. Sólo cuentan los casos con la verdad conocida.
- **Métricas por `engine_version`:**
  - top-1 y top-3;
  - top-1 incorrecto con puntaje alto;
  - recall de candidatos: si el correcto aparece en el top-N;
  - tiempo por decisión en la bandeja.
- **Gemini** entra si sube el top-3 respecto del motor solo, sin bajar el top-1.
- **Puntaje visible:** sólo se muestra como confianza cuando la precisión por tramo está medida con al menos 200 casos. Hasta entonces, la bandeja muestra el orden y la explicación.

## 10. API y bandeja

**API v2**, en `plataforma/src/api/identidad.ts`, con el mismo patrón que `api/catalogo.ts`:

| Método | Ruta | Uso |
|---|---|---|
| GET | `/api/v2/identity/cases` | lista paginada por cursor, con filtros por tipo, estado y prioridad |
| GET | `/api/v2/identity/cases/{id}` | detalle con evidencia, candidatos e historial |
| POST | `/api/v2/identity/cases/{id}/decisions` | decidir, con `Idempotency-Key` y `expected_version`; en conflicto responde 409 |

Errores `{code,message,correlation_id,details?}`.

**Bandeja**, pantalla web para José:
- **Prioridad:** conflictos → las 17 de D5 → SKU exacto no auto-vinculable → publicaciones activas con stock → el resto.
- **Contenido de cada caso:** la publicación de ML (foto, título, SKU, precio) y 3 candidatos con su explicación.
- **Acciones:** elegir candidato, buscar otro, omitir o «no existe en el catálogo».
- **Estados de pantalla:** cargando, vacío, error y conflicto 409 (refresca sin perder lo elegido).
- **Calidad:** 390/768/1440 y WCAG 2.2 AA.
- **Permisos:** los del legado por herramienta (matcher); sólo el admin revierte una decisión.

*A verificar en el plan:* dónde vive la pantalla (el legado `public/` consumiendo la API v2 o la plataforma) y cómo se autentica, siguiendo lo que ya usa el catálogo v2.

## 11. Pruebas y aceptación

- **`npm run test:e3`**, que tiene que fallar si falta cualquiera de estos escenarios:
  - auto-vínculo sólo con SKU único;
  - empate: no vincula;
  - GTIN nunca vincula;
  - relectura con cambio → intervention;
  - relectura con 5xx → parked;
  - 401 aborta el canario;
  - las 17 bloqueadas;
  - 409 con dos operadores;
  - una decisión del legado posterior → conflict;
  - idempotencia;
  - desorden y duplicados;
  - flag apagado → comportamiento de hoy;
  - la calibración reproduce las métricas de la muestra.
- **E2E** de la bandeja en 3 anchos, con axe.
- **Aceptación:**
  - 7 días de sombra con métricas registradas;
  - replay;
  - canario con 0 errores (D6);
  - 0 decisiones contradictorias sin caso;
  - auditoría completa;
  - suites de plataforma y legado en verde;
  - revisión independiente sin hallazgos altos.

## 12. Cortes (cada uno usable)

1. **Bandeja con autoridad + motor en sombra.** José decide casos desde el día 1 y sus decisiones se aplican (flag `E3_BANDEJA`). El motor sólo sugiere y calcula `auto_sku` en sombra. Arranca la ventana de 7 días de calibración.
2. **Gemini para candidatos**, medido contra la muestra. Entra o se descarta.
3. **Canario del auto-SKU** (flag `E3_CANARIO`) + replay, sobre los 7 días de decisiones de José.
4. **Auto-SKU encendido** (flag `E3_AUTO_SKU`). Lo autoriza José después del canario.
