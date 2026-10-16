# Sombra: validación para integrar PR38, PR45 y PR42

Fecha: 2026-10-16. Alcance: integrar Git, sin desplegar ni reiniciar servicios, cambiar cupos o escribir datos comerciales.

Base: master `1cf751f4`. Revisiones examinadas: PR38 `25b7f449`, PR45 `d3b30707`, PR42 `79f0bcd3`. La combinación previa a las correcciones es `2de41b16`. El único conflicto fue documental en operations-vps; se preservaron ambos aportes.

## Correcciones de revisión

- Woo: la restauración del padre sólo reabre hijas cuya observación propia sea `open`. Una hija en papelera, eliminada o sin observación permanece archivada. Un estado remoto `deleted` heredado espera su propia proyección válida.
- Mensajes: validar IDs también al reanudar checkpoints; recortar antes de omitir inválidos para avanzar sin saltar recursos fuera del tope.
- La lectura liviana toma sólo señales `pending`, `claimed` y `retryable`. Un 404 no modifica la señal ni genera una baja: el consumidor mantiene sus reintentos acotados y la evidencia de agotamiento. Las señales terminales requieren replay explícito.

La revisión independiente del código final no dejó bloqueos. Las regresiones usan PostgreSQL efímero, el consumidor real de señales y el validador real de rutas; el transporte remoto es simulado.

## Validación

La suite base de plataforma pasó 1.076 pruebas antes de los cambios. Las regresiones nuevas reprodujeron seis fallos sobre ese código y quedaron verdes tras corregirlo. Se incorporaron siete pruebas nuevas; una comprueba el comportamiento ya correcto del relector ante 404 temporal.

Typecheck final: correcto. Regresiones focalizadas:

```text
Test Files  3 passed (3)
Tests  73 passed (73)
Duration  15.08s (tests 91%, transform 7%, import 2%)
```

Suite completa de plataforma con las correcciones:

```text
Test Files  95 passed (95)
Tests  1083 passed (1083)
Duration  177.68s (tests 92%, import 6%, transform 2%)
```

Suite raíz y pruebas Node de migración (sin cambios posteriores en su código):

```text
Test Files  260 passed | 1 skipped (261)
Tests  4642 passed | 51 skipped (4693)
Duration  942.90s (transform 10.54s, setup 0ms, import 69.46s, tests 823.05s, environment 36ms)
ℹ tests 105
ℹ pass 104
ℹ fail 0
ℹ skipped 1
```

Las suites se ejecutaron de forma serial en el worktree aislado, sin .env productivo ni bases comerciales compartidas. Los casos omitidos son los ya declarados por las suites.

## Integración y operación

Orden de integración: [PR38](https://github.com/fusionbikesok-ui/Herramientas/pull/38), [PR45](https://github.com/fusionbikesok-ui/Herramientas/pull/45) sobre master y [PR42](https://github.com/fusionbikesok-ui/Herramientas/pull/42). Verificar que el árbol final coincida con el candidato probado y que checkout, contenedores y configuración productivos no cambien.

El worker r4 permanece publicado. Las correcciones de esta revisión todavía requieren un despliegue controlado propio; fusionar Git no las activa. Se conserva la captura de corrientes futuras y E2/E3 siguen sin habilitarse. E1 no queda aceptada: siguen pendientes la estabilidad sostenida de 24–48 horas y los siete días verdes.
