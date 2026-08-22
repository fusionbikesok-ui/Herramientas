# Arquitectura y contratos internos

## Hechos durables

- La aplicación usa Node.js/Express con módulos ESM, SQLite mediante `better-sqlite3` y
  Vitest.
- El contrato HTTP documentado está en `docs/api-contrato.md`; consultarlo solo cuando el
  cambio afecte endpoints o consumidores.

## Decisiones vigentes

- Los planes de cambios normales o grandes viven en `docs/superpowers/plans/`.
- Las especificaciones de diseño viven en `docs/superpowers/specs/`.

## Cuándo actualizar

Solo ante cambios de arquitectura, contratos, estructura canónica o decisiones transversales.
