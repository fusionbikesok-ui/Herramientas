# UI, UX y pruebas de navegador

## Fuentes normativas

- Sistema visual existente: `public/lib/theme.css`.
- Roles especializados: `.claude/agents/disenador-ux.md`,
  `.claude/agents/disenador-ui.md` y `.claude/agents/probador-e2e.md`.
- El acceso de prueba se resuelve solo durante una ejecución E2E autorizada; no persistir ni
  copiar credenciales en la memoria.

## Decisiones vigentes

- Los cambios normales o grandes de UX/UI se diseñan antes de implementar.
- Todo cambio en `public/` requiere prueba E2E interactiva y evidencia responsive antes del
  gate final.
- Matcher mantiene visible pero deshabilitada la dirección ML→Woo mientras no esté disponible,
  con su conteo informativo; las colisiones de vínculos ofrecen inspección y solo permiten
  deshacer al autor o a un administrador.
- Preparación carga todas las páginas de seguimientos pendientes y distingue visualmente los
  resultados inciertos que requieren verificación.

## Cuándo actualizar

Ante cambios durables de navegación, sistema visual, accesibilidad, breakpoints o estrategia
de pruebas UI.
