import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const JS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../js');

/**
 * Load one or more of the app's classic (non-module) script files and return
 * the named top-level functions/constants they declare.
 *
 * The real app loads these via <script> tags into one shared global scope, so
 * they reference each other by bare name. We reproduce that by concatenating
 * the requested files (in load order) and evaluating them in a single function
 * scope, then returning the symbols asked for. Browser globals (document,
 * localStorage, …) come from Vitest's jsdom environment.
 *
 * @param {string[]} files   filenames under frontend/js, in load order
 * @param {string[]} symbols top-level names to extract
 * @returns {Record<string, any>}
 */
export function loadScripts(files, symbols) {
  const src = files
    .map((f) => fs.readFileSync(path.join(JS_DIR, f), 'utf8'))
    .join('\n');
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${src}\n;return { ${symbols.join(', ')} };`);
  return factory();
}
