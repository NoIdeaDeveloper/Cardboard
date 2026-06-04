import fs from 'node:fs';
import path from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';

const DIST = '/Users/jeffgoldblum/Documents/GitHub/cardboard/frontend/dist';
const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
const classic = fs.readFileSync(fs.globSync(path.join(DIST, 'js/bundle.*.js'))[0], 'utf8');
const app = fs.readFileSync(fs.globSync(path.join(DIST, 'js/app.*.js'))[0], 'utf8');

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => errors.push(e));

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole: vc,
  url: 'http://localhost/',
});
const { window } = dom;

// Minimal browser stubs the app touches during init.
window.fetch = () => Promise.resolve({
  ok: true, status: 200,
  headers: { get: () => null },
  json: () => Promise.resolve([]),
  text: () => Promise.resolve(''),
  clone() { return this; },
});
window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
window.scrollTo = () => {};
window.HTMLCanvasElement.prototype.getContext = () => null;

function run(label, code) {
  const s = window.document.createElement('script');
  s.textContent = code;
  try {
    window.document.body.appendChild(s);
  } catch (e) {
    errors.push({ label, err: e });
  }
}

// Load in the same order index.html does: classic globals first, then app.
run('classic', classic);
run('app', app);

// Trigger the app's DOMContentLoaded init path.
window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));

setTimeout(() => {
  const refErrors = errors.filter((e) => {
    const msg = (e?.detail?.message || e?.err?.message || String(e?.detail || e?.err || e));
    return /is not defined|ReferenceError/.test(msg);
  });
  console.log('total jsdomErrors captured:', errors.length);
  if (refErrors.length) {
    console.log('!!! ReferenceErrors (broken cross-bundle global):');
    for (const e of refErrors) console.log('   ', e?.detail?.message || e?.err?.message || e);
    process.exit(1);
  }
  // Show any non-reference errors for visibility (network/DOM noise is expected/acceptable).
  for (const e of errors.slice(0, 5)) {
    console.log('  note:', (e?.detail?.message || e?.err?.message || String(e)).split('\n')[0]);
  }
  console.log('SMOKE OK: no ReferenceErrors — cross-bundle globals resolve.');
}, 300);
