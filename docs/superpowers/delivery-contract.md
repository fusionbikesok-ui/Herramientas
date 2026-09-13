# Contrato obligatorio de una entrega E

Una ficha sólo puede pasar de `borrador` a `planificada` cuando otra persona o modelo pueda ejecutarla
sin elegir diseño, esquema, API, conducta ante fallos, prueba, rollout ni rollback.

Debe declarar explícitamente: estado, resultado tangible, dependencias, responsables, superficies,
exclusiones; línea base fechada y reproducible; decisiones e invariantes; componentes, datos,
restricciones y estados; contrato completo de APIs; contrato de cada integración; migración repetible
y conciliada; fallos, DLQ, compensaciones y efectos irreversibles; UI, accesibilidad, offline y SOP;
observabilidad con umbrales y guardia; pruebas con fixture y evidencia; flags, simulación, sombra,
canario, corte menor a 15 minutos, aborto y rollback; aceptación técnica y operativa, y próxima acción.

Una cifra debe incluir fecha, origen y comando de obtención. Una afirmación debe distinguir código
existente, despliegue observado, uso real y aceptación. `TODO`, `TBD`, “por definir”, una API supuesta,
una decisión abierta o un rollback genérico mantienen la ficha en `borrador` y bloquean el trabajo.

El validador se ejecuta con:

```bash
npm run docs:validate-deliveries
```

El validador comprueba continuidad, IDs, estados, dependencias, secciones, marcadores pendientes,
enlaces locales vigentes, cobertura exacta de decisiones y ausencia de rutas operativas al archivo.
