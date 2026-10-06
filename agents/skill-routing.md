# Uso puntual de skills por agentes

Los roles de `.claude/agents/` son opt-in. Cada agente usa solo las skills que aporten a su
encargo concreto; no debe cargar un paquete fijo, redescubrir el repositorio ni encadenar otro
agente.

- `disenador-ux`: únicamente si se diseña o cambia un flujo, estados, arquitectura de
  información o copy. Puede usar `interaction-design`, `ux-writing` y `handoff-spec`.
- `disenador-ui`: únicamente si se diseña o cambia la presentación visual, componentes,
  tokens, responsive o accesibilidad. Puede usar `ui-design`, `design-systems` y
  `design-qa-checklist`.
- `revisor`, `tester`, `probador-e2e` y `auditor-despliegue`: usan solo las comprobaciones
  necesarias para el riesgo y alcance que se les indique.

La sesión principal decide si el beneficio de una skill o un agente justifica su costo. Ninguna
skill ni rol constituye un gate automático.
