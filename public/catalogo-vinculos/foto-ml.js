// Helper puro: versión grande de la foto de una publicación de ML.
// Regla: solo https://*.mlstatic.com; cambia el sufijo "-I.jpg|webp" por "-O.jpg|webp" (la query se conserva).
// Cualquier otra URL se devuelve tal cual. null/undefined/'' se devuelven sin cambios.
// Expuesto como global `CvFotoMl` en el navegador y como module.exports en Node (tests con vm).
(function (raiz) {
  function fotoMlGrande(url) {
    if (typeof url !== 'string' || !url) return url;
    var m = /^([^?#]*)([\s\S]*)$/.exec(url);
    var base = m[1], resto = m[2];
    // Parseo por regex (no URL): así funciona igual en cualquier contexto, incluido vm en tests.
    var a = /^https:\/\/([^\/@]+)(\/|$)/i.exec(base);
    if (!a) return url;
    var host = a[1].replace(/:\d+$/, '').toLowerCase();
    if (host !== 'mlstatic.com' && !/\.mlstatic\.com$/.test(host)) return url;
    if (!/-I\.(jpg|webp)$/i.test(base)) return url;
    return base.replace(/-I\.(jpg|webp)$/i, '-O.$1') + resto;
  }
  var api = { fotoMlGrande: fotoMlGrande };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else raiz.CvFotoMl = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
