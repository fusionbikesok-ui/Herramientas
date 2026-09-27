# Noche 2026-09-27: supuestos, conclusiones y preguntas para José

José se fue a dormir alrededor de las 02:30 UTC con esta indicación: "seguí hasta que vuelva, sin parar con E3".

Reglas que sigo durante la noche:
- Sin despliegues y sin escrituras en producción.
- Todo lo que asumo queda anotado acá para que lo confirmes.

## Listo para desplegar (espera tu OK y tus comandos con `!`)

- **`fix/bandeja-atributos-variante`, `6f310673`**
  - Aprobaciones: Codex sol, revisor sin bloqueantes, auditor en verde y Playwright OK.
  - Tests: 103/103.
  - No trae migración.
  - Los comandos están en el chat (bloques 1 a 4, más el rollback).

## En curso

- **`fix/ml-atributos-sin-modelo`**: migraciones 0028/0029 más el backfill. Va por la ronda 3 de arreglos: el checksum de la 0028 y la reparación de estados heredados.
- **E3 corte 3**: segunda opinión de Codex sol sobre el diff completo del corte (tarea 8, paso 3).
- **Snapshot anonimizado**: clasificar las 2 columnas nuevas.
- **Deuda menor de la bandeja** y actualización del plan maestro.

## Supuestos que tomé (confirmá o corregí)

1. **La 0028 nunca se aplicó en un entorno persistente**, así que editarla es seguro. Producción está en la 0027. La otra sesión lo verifica en QA y en los contenedores de test.
2. **La bandeja compara solo esta lista cerrada de atributos**:
   - marca
   - modelo
   - color
   - talle / tamaño del cuadro
   - rodado
   - material / material del cuadro
   - tipo de producto / tipo de bicicleta
   - género
   - edad
   - cantidad de velocidades

   Quedan fuera paquete, IVA, ids, guía de talles y similares. **¿Falta alguno que uses para decidir?**
3. **Si falla la clasificación al vincular, el vínculo se mantiene** (fail-open) y queda registrado el evento `catalogo.clasificacion_fallida`. La alternativa sería rechazar la decisión completa.
4. **El rollback de la API usa las imágenes `antes-bandeja` y `antes-atributos`**, porque la imagen original de la API ya no existía en Docker.
5. **Los representantes que estaban vinculados y después se omitieron conservan hoy los atributos del modelo viejo en producción.** Lo deduzco del código; falta contarlos con una consulta de solo lectura. El nuevo modo `--reparar-extras` del backfill los corrige.

6. **Cupo de Codex sol (vos preguntaste a las ~02:40):** para no agotarlo, sol se usa solo en entregas de riesgo alto: esquema y migraciones, scripts que escriben en producción, lógica de vínculos y E3. En diffs chicos va con effort medium. Lo de riesgo bajo (snapshot, deuda de UI, tests, docs) pasa solo por el revisor y lleva una única revisión sol en lote al final. Si el cupo se agota, lo no revisado queda como "pendiente de revisión" y no se ofrece para deploy. No reemplazo sol por Claude.

## Preguntas abiertas

(se completan durante la noche)
