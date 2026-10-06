-- E1 T3 · corte C3: nonces de la API interna de señales.
-- El nonce vive en PostgreSQL y no en memoria: un reinicio de la API no puede reabrir la ventana de
-- replay de cinco minutos. La clave primaria es la defensa; la purga sólo acota el tamaño.
CREATE TABLE integrations.signal_nonces (
  key_id  text NOT NULL CHECK (length(key_id) BETWEEN 1 AND 128),
  nonce   text NOT NULL CHECK (length(nonce) BETWEEN 16 AND 128),
  seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key_id, nonce)
);
CREATE INDEX signal_nonces_seen_at ON integrations.signal_nonces(seen_at);

-- La purga borra nonces vencidos: DELETE no está en los privilegios por defecto de 0002.
GRANT DELETE ON integrations.signal_nonces TO plataforma_app;
