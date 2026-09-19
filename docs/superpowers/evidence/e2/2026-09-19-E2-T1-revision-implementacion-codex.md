# Revisión externa de la implementación de E2 T1 (Codex, gpt-5.6-sol, esfuerzo bajo) — 2026-09-19

Sólo lectura, sobre los commits `5d4e812..a33ca5e` (tareas 1 a 13). Un crítico, cinco altos y un medio. Los siete se
verificaron contra el código antes de tocar nada; los siete eran reales y se corrigieron.

| # | Hallazgo | Arreglo | Prueba |
|---|---|---|---|
| C1 | Dos mensajes simultáneos de un recurso NUEVO no encontraban fila que bloquear: cada uno creaba su variante y el más viejo podía pisar al más nuevo, dejando una variante huérfana. Hoy corre un solo worker, pero con dos réplicas pasaba | Candado por recurso al entrar a `aplicarProyeccion`, antes de tocar filas. Orden: recurso → representación → decisiones → variantes | Dos proyectores con dos versiones de cinco recursos nuevos: una variante por recurso y gana la más nueva. **Sin el candado, el test falla** |
| A1 | Una fila del legado que no se podía traducir quedaba afuera de la copia, y su ausencia cerraba en silencio la decisión o el caso vigente | Con filas inválidas la copia no se manda y abre `copia_fallida` | Copia diaria con una clave rota: no llama a la plataforma y abre el incidente |
| A2 | E2 admitía un `identidad_legado` abierto por publicación; el legado, uno por dirección. Colapsaban, y resolver uno cerraba el otro | El índice único incluye `detalle->>'caso_legado'`; copia y eventos buscan por caso | Dos casos sobre la misma publicación conviven; cerrar uno no toca el otro, por copia y por evento |
| A3 | El freno por tasa de error no contaba los rechazos | Cuentan los dos | 12 mensajes entre ilegibles y rechazados detienen el proyector |
| A4 | El lease del bootstrap no se renovaba; una página de Woo lenta lo superaba y otro worker la retomaba sin que ninguno pudiera confirmar | Se renueva antes de cada llamada al canal; si otro lo tomó, la página se abandona | Un segundo worker que entra con el lease original ya vencido la encuentra ocupada. **Sin renovar, la roba** |
| A5 | El proyector reclamaba 20 mensajes con 60 s de lease; los últimos vencían esperando turno y terminaban en la DLQ sin proyectarse | Reclama de a uno | La suite del proyector completa |
| M1 | Cambios sólo de clasificación o dirección de un caso nunca llegaban a E2 | El trigger los captura y la copia actualiza prioridad y detalle | Legado y plataforma |

## Lo que la corrección de A3 destapó

Contar los rechazos hacía que **un solo** rechazo legítimo (un producto agrupado de Woo) en una vuelta de un mensaje
fuera el 100 % y detuviera el proyector para siempre; con los errores transitorios pasaba lo mismo desde antes. El
umbral pasó a medirse sobre los últimos 50 mensajes, con un mínimo de 10 para decidir.

## Verificación

Gate de E2 (`npm run test:e2`): 16 IDs y 27 escenarios, 189 pruebas. Suites completas en serie: plataforma 413/413,
legado 2.749 en verde, sin fallos.
