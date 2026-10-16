/**
 * FBPOSApp.api
 * Helper para llamadas a la REST API
 */
(function() {
  window.FBPOSApp = window.FBPOSApp || {};

  /**
   * Realiza una llamada a la REST API de WordPress
   * Maneja correctamente permalinks Pretty y Plain
   * @param {string} path - Ruta relativa al endpoint (ej: '/search?q=...')
   * @param {object} opt - Opciones de fetch (method, body, headers, etc)
   * @returns {Promise<object>} Resultado JSON
   */
  FBPOSApp.api = async function(path, opt = {}) {
    // Separar pathname del query string para construir la URL correctamente
    const [pathname, queryString] = path.split('?');
    const url = new URL(FBPOS.rest + pathname);

    // Agregar parámetros query si existen
    if (queryString) {
      const params = new URLSearchParams(queryString);
      params.forEach((value, key) => url.searchParams.append(key, value));
    }

    const response = await fetch(url.toString(), {
      ...opt,
      headers: {
        'Content-Type': 'application/json',
        'X-WP-Nonce': FBPOS.nonce,
        ...(opt.headers || {})
      }
    });

    const json = await response.json();

    if (!response.ok) {
      throw new Error(json.message || 'Error');
    }

    return json;
  };
})();
