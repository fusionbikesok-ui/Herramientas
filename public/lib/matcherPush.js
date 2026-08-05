/*
 * public/lib/matcherPush.js — Cliente compartido del push de SKUs a ML.
 *
 * El push corre en el SERVIDOR (cron cada 10 min + POST para disparar una corrida ahora).
 * El POST devuelve 202 al toque (o 409 si ya hay una corriendo) y el progreso se sigue
 * sondeando con GET .../estado. Esta lógica vivía duplicada en public/matcher/index.html
 * y public/sync-detalle/index.html contra el contrato VIEJO (que ya no existe); se extrae
 * acá una sola vez y ambas páginas la consumen.
 *
 * Se carga como <script src="../lib/matcherPush.js"></script> (script clásico, no module).
 *
 * Uso:
 *   var push = MatcherPush.crear('/herramientas/api/matcher/push-skus-pendientes');
 *   var cont = await push.contar();      // {pendientes, activas, pausadas, en_espera}
 *   await push.iniciar();                // dispara la corrida (202/409, no lanza por 409)
 *   await push.sondear({
 *     onRunning: function(est){ ... },     // se llama cada ~3s mientras est.running
 *     onDone: function(est){ ... },        // se llama una vez al terminar (éxito o error)
 *   });
 */
(function (root) {
  'use strict';

  function crear(baseUrl, opts) {
    opts = opts || {};
    var intervaloMs = opts.intervaloMs || 3000;
    var sondeoActivo = false;

    function contar() {
      return fetch(baseUrl + '/count').then(function (r) { return r.json(); });
    }

    function listar() {
      return fetch(baseUrl + '/list').then(function (r) { return r.json(); });
    }

    function estado() {
      return fetch(baseUrl + '/estado').then(function (r) { return r.json(); });
    }

    // Dispara la corrida. 202 = arrancó; 409 = ya había una corriendo (no es un error para
    // quien llama: en ambos casos corresponde pasar a sondear el progreso).
    function iniciar() {
      return fetch(baseUrl, { method: 'POST' }).then(function (r) {
        return r.json().then(function (d) {
          if (!(r.status === 202 || r.status === 409 || d.ok)) {
            throw new Error(d.error || 'error del servidor');
          }
          return d;
        });
      });
    }

    // Sondea GET .../estado hasta que la corrida (propia o del cron) termina.
    // Devuelve una Promise que resuelve con el estado final. Anti-solape: si ya hay un
    // sondeo activo para esta instancia, no arranca otro.
    function sondear(cbs) {
      cbs = cbs || {};
      if (sondeoActivo) return Promise.resolve(null);
      sondeoActivo = true;
      function loop() {
        return estado().catch(function () { return null; }).then(function (est) {
          if (!est || !est.ok) {
            return new Promise(function (res) { setTimeout(res, intervaloMs); }).then(loop);
          }
          if (est.running) {
            if (cbs.onRunning) cbs.onRunning(est);
            return new Promise(function (res) { setTimeout(res, intervaloMs); }).then(loop);
          }
          if (cbs.onDone) cbs.onDone(est);
          return est;
        });
      }
      return loop().finally(function () { sondeoActivo = false; });
    }

    function estaSondeando() { return sondeoActivo; }

    return { contar: contar, listar: listar, estado: estado, iniciar: iniciar, sondear: sondear, estaSondeando: estaSondeando };
  }

  root.MatcherPush = { crear: crear };
})(window);
