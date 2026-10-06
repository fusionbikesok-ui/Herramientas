
## Deuda declarada (T6, 2026-09-24)

- **H7 fuera de este corte:** la reversión por un admin de decisiones viejas o ajenas (diálogo con motivo obligatorio, entrada desde el historial) no tiene pantalla; la API la soporta y la bandeja muestra el historial en sólo lectura.
- El recorrido contra QA con Postgres real se hace en T8, junto con la suite completa.
- **`S.ultima` se pisa** si la decisión A sigue en vuelo y otra decisión B falla o se hace después: el deshacer sólo cubre la última decisión propia (aceptado por ahora).
