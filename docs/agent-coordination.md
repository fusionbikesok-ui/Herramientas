# Coordinación puntual entre agentes

Los agentes son especialistas opt-in, no una cadena de trabajo. La sesión principal implementa,
verifica e integra por defecto; puede delegar una tarea separable cuando su beneficio justifica
el contexto adicional.

## Reglas

- No hay motor, modelo, nivel de razonamiento, handoff estructurado ni secuencia obligatoria.
- No se invoca un agente para un ajuste local, evidente o de bajo riesgo; tampoco se encadenan
  agentes por costumbre.
- Los diseñadores se usan únicamente al diseñar un flujo o presentación; revisor, tester, E2E y
  auditor se invocan individualmente según el riesgo y la incertidumbre concretos.
- Un agente recibe objetivo, alcance, rutas conocidas, restricciones y evidencia ya disponible.
  Devuelve una conclusión breve y verificable; no redescubre trabajo ni invoca a otro agente.
- Para trabajo paralelo real, cada escritor usa rama y worktree propios; un archivo tiene un
  único escritor a la vez. Los lectores no modifican el repositorio.
- Nunca se inicia `node server.js` contra `data/fusion.sqlite`, se deja un proceso temporal vivo
  ni se corren suites simultáneas que compartan SQLite temporal.
- Las pruebas se ejecutan en proporción al cambio. Antes de una suite completa, verificar que no
  haya Vitest ni servidores temporales activos; ante un fallo ajeno, repetir primero el archivo
  aislado.
- Un commit no autoriza push, despliegue, reinicio de PM2 ni migración productiva.

Los scripts y esquemas del antiguo pipeline permanecen solo como legado técnico y no son una
forma autorizada de despachar trabajo nuevo.
