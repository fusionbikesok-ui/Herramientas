-- Cobertura accionable (matcher inverso WC → ML): estados de trabajo que NO tienen tabla
-- propia todavía. `vinculado` y `descartado` ("solo local") NO se agregan acá a propósito:
-- reutilizan sku_matcher_decisiones (accion='confirmar') y cobertura_exclusiones — regla
-- explícita del encargo, para no duplicar la fuente de verdad que ya usa pushSkusPendientes.

-- Cola "hay que publicarlo": productos sin candidato usable en ML, o mandados ahí a mano
-- desde la tarjeta. Ordenada por valor en el endpoint, no acá. `tachado` es el check manual
-- de la lista (no dispara ninguna acción de sistema, ver plan de flujo §8).
CREATE TABLE IF NOT EXISTS cobertura_hay_que_publicar (
  id_woo INTEGER PRIMARY KEY,
  sku TEXT,
  nombre TEXT,
  marca TEXT,
  valor REAL,
  tachado INTEGER NOT NULL DEFAULT 0,
  creado_en TEXT NOT NULL
);

-- "Saltear": NO es un estado terminal (ver diagrama del flujo). Un producto salteado sigue
-- en la cola pendiente de su marca, pero ordenado al final de la tanda en vez del principio.
CREATE TABLE IF NOT EXISTS cobertura_salteados (
  id_woo INTEGER PRIMARY KEY,
  marca TEXT,
  creado_en TEXT NOT NULL
);

-- "Seguir donde quedé": singleton (id=1) con la última marca trabajada, para que la pantalla
-- de entrada pueda ofrecer retomar sin que el usuario tenga que recordar por dónde iba.
CREATE TABLE IF NOT EXISTS cobertura_sesion (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  marca_actual TEXT,
  actualizado_en TEXT NOT NULL
);

-- "Marcar correcta" en Multi-publicación y Solo ML: decisión puramente local (no escribe en
-- ML) que saca esa publicación puntual (por clave) de esas listas para que no vuelva a
-- aparecer. `seccion` distingue el origen para poder filtrar por lista.
CREATE TABLE IF NOT EXISTS cobertura_marcados_correcto (
  clave TEXT PRIMARY KEY,
  seccion TEXT NOT NULL,
  marcado_en TEXT NOT NULL
);
