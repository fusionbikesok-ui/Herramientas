export function createContinuousGate() {
  let currentCode = null;
  return {
    frame(code) {
      if (!code) {
        currentCode = null;
        return null;
      }
      if (code === currentCode) return null;
      currentCode = code;
      return code;
    },
  };
}

if (typeof window !== 'undefined') {
  window.ScannerGate = { createContinuousGate };
}
