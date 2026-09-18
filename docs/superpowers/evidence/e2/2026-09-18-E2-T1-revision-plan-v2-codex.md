# Segunda revisión externa del plan de E2 T1 (Codex, gpt-5.6-sol, esfuerzo bajo) — 2026-09-18

Sólo lectura. Plan evaluado: `plans/2026-09-18-e2-tramo1-modelos-variantes.md` en el commit `0d2aad8`, que ya
incorporaba los 26 hallazgos de la primera revisión (`2026-09-18-E2-T1-revision-plan-codex.md`) y las seis
decisiones de José.

**Veredicto sobre los 26 anteriores: bien resueltos, sin regresiones.** No encontró ninguno a medias.

## Los cuatro hallazgos nuevos

1. **Tareas 9, 10 y 14 — la outbox sigue sin cableado operativo.** Falta definir quién ejecuta el despachador, su
   configuración y HMAC, la frecuencia, el apagado y la recuperación tras un reinicio. "Encender la outbox" no era
   implementable con los archivos y las tareas que el plan enumeraba.

2. **Tarea 14, pasos 4 y 5 — ventana de pérdida.** El plan copiaba el matcher y recién después habilitaba la captura
   de eventos: cualquier cambio hecho entre los dos pasos desaparecía, sin quedar ni en la copia ni en los eventos.
   Primero tiene que estar activa la escritura durable en la outbox —con el envío pausado si hace falta— y después
   tomarse la copia con su corte.

3. **Tarea 14 — falta un gate de dependencia con E1.** El diseño declara que E2 se apoya en los barridos y el inbox
   de E1, pero E1 todavía no está aceptada ni terminó su campaña de 7 días. No hay que migrar ni encender E2 sin
   verificar antes que la infraestructura, los productores del inbox, el gateway, el worker, la API y los secretos
   de E1 estén operativos.

4. **Tarea 12 — "cede si hay órdenes de ML esperando" no define una señal observable.** El bootstrap corre en la
   plataforma, mientras la demanda prioritaria y el cupo compartido viven en el gateway del legado. Si se
   interpretara como "mensajes `ml.orders` pendientes en el inbox", el bootstrap quedaría pausado indefinidamente,
   porque hoy nadie consume ese inbox.

## Cómo se incorporaron

En el plan, numerados 27 a 30 en la tabla de la segunda revisión:

| # | Dónde |
|---|---|
| 27 | Tarea 9: tabla de cableado (quién, cada cuánto, firma, apagado, recuperación, una sola instancia) y tres tests nuevos |
| 28 | Tarea 14: pasos 4 a 6 reordenados — capturar primero con el despachador apagado, copiar después, despachar al final |
| 29 | Tarea 14: paso 0, gate de seis verificaciones sobre E1 que para todo si algo está en rojo |
| 30 | Tarea 12: cede por señales reclamables de ML (más de 20) y por 429; el inbox explícitamente **no** es criterio |
