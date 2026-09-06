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
];
