# Estado retirado — enrutamiento de modelos

Este repositorio no prescribe motor, modelo, nivel de razonamiento, escalada ni sandbox para
subagentes. La elección corresponde a la sesión que los invoca y no es una condición para usar
un rol.

Los agentes de `.claude/agents/` son ayudas opt-in, no etapas de un pipeline. Se invocan solo
cuando su especialidad aporta señal concreta a la tarea; no se encadenan por costumbre.

`agents/routing.json` y los scripts `agent:*` son legado fuera de uso y no deben usarse para
despachar trabajo nuevo.
