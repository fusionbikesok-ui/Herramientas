// Gate para escaneo continuo por cámara. Evita re-disparar el mismo código
// mientras el producto sigue a la vista, y solo lo "olvida" (permitiendo volver
// a contarlo) cuando desaparece del cuadro.
//
// dropoutMs: mínimo que el código debe estar AUSENTE del cuadro antes de darlo
// por retirado. Con 0 (default) se olvida apenas hay un frame vacío. Con un
// valor > 0, un parpadeo breve de la cámara (un frame sin lectura con el mismo
// producto todavía adelante) NO resetea el gate, evitando el doble conteo; pero
// retirar el producto de verdad (ausente ≥ dropoutMs) sí lo resetea, así que
// cambiar de unidad cuenta al instante, sin frenar el conteo.
export function createContinuousGate(options) {
  const dropoutMs = options && options.dropoutMs != null ? options.dropoutMs : 0;
  let currentCode = null;
  let nullSince = null;
  return {
    frame(code, now) {
      const t = now == null ? Date.now() : now;
      if (!code) {
        if (currentCode !== null) {
          if (nullSince == null) nullSince = t;
          if (t - nullSince >= dropoutMs) { currentCode = null; nullSince = null; }
        }
        return null;
      }
      nullSince = null;
      if (code === currentCode) return null;
      currentCode = code;
      return code;
    },
  };
}

if (typeof window !== 'undefined') {
  window.ScannerGate = { createContinuousGate };
}
