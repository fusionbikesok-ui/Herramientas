/*
 * Configuración de ESLint — FusionBikes.
 *
 * Existe por un bug concreto (2026-09-06): `lib/identidadProductos.js` usaba
 * `frescuraVigenteMs` sin haberla importado, un `try/catch` de respaldo se tragaba el
 * `ReferenceError` y devolvía el valor por defecto. La suite quedaba EN VERDE mientras la
 * cadencia adaptativa del scan no gobernaba absolutamente nada. `no-undef` lo marca en el acto
 * y es la única defensa que no depende de que alguien se acuerde de escribir un test.
 *
 * El gate corre sobre los archivos que toca el diff (`npm run lint:diff`), no sobre todo el
 * repo: así sirve desde el primer día sin exigir limpiar antes los ~200 archivos heredados.
 * `npm run lint` recorre todo para medir la deuda cuando haga falta.
 */
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'data/**', 'public/**/vendor/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // Las variables sin usar avisan, no frenan: suelen ser restos de un refactor y no un
      // error de ejecución. Se permite el prefijo `_` para los argumentos que se descartan a
      // propósito, que en este repo aparecen bastante (`(_req, res)`).
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    files: ['test/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.vitest } },
  },
  {
    // Los scripts de smoke manejan un navegador: el código dentro de `page.evaluate()` corre
    // ALLÁ, no acá, así que `window` y `document` son legítimos aunque el archivo sea de Node.
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    // El frontend es vanilla en el navegador, sin build. `sourceType: module` porque
    // public/lib/scanner.js y scannerGate.js usan import/export nativos.
    files: ['public/**/*.js'],
    languageOptions: { sourceType: 'module', globals: { ...globals.browser } },
  },
  {
    // Web Worker: tiene sus propios globales (`importScripts`, `self`).
    files: ['public/**/*worker*.js'],
    // `MatcherEngine` no se importa: lo trae `importScripts` en tiempo de ejecución, así que
    // para el analizador es un global del worker como cualquier otro.
    languageOptions: { sourceType: 'script', globals: { ...globals.worker, MatcherEngine: 'readonly' } },
  },
  {
    // Excepción acotada y temporal (decisión del usuario, 2026-09-06). `db/index.js` arrastra
    // 57 `catch {}` repartidos entre las líneas 154 y 1107 —8 en migraciones, 18 alrededor de
    // ALTER/PRAGMA, 31 en otros lugares—, todos anteriores al linter. Con el gate acotado al
    // diff, cualquier cambio mínimo acá (registrar una migración nueva son ~10 líneas) obliga
    // a saldar esa deuda en el mismo commit, mezclando dos trabajos en el archivo más sensible
    // del arranque.
    //
    // Es deuda reconocida, no un permiso: la regla sigue activa en todo el resto del proyecto,
    // y saldarla exige revisar los 57 uno por uno —los deliberados llevan el comentario que
    // explica por qué están vacíos, y los que no, se arreglan—, porque un `catch` mudo que
    // esconde un error real es exactamente el bug que motivó adoptar ESLint (PM-148/PM-149).
    // Al levantar esta excepción hay que borrar este bloque, no ampliarlo a otros archivos.
    files: ['db/index.js'],
    rules: { 'no-empty': 'off' },
  },
];
