#!/usr/bin/env node
'use strict';

const esbuild = require('esbuild');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');

const SRC  = 'frontend';
const DIST = path.join(SRC, 'dist');

// Load order matches the <script> tags in index.html
const JS_ORDER = [
  'shared-utils.js', 'theme.js', 'ui-helpers.js',
  'api.js', 'ui.js', 'confetti.js', 'app.js',
];

async function main() {
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIST, 'js'),  { recursive: true });
  fs.mkdirSync(path.join(DIST, 'css'), { recursive: true });

  // Concatenate and minify all JS in load order
  const combined = JS_ORDER
    .map(f => fs.readFileSync(path.join(SRC, 'js', f), 'utf8'))
    .join('\n');
  const jsResult = await esbuild.transform(combined, { minify: true, loader: 'js' });
  const jsHash   = hash8(jsResult.code);
  const jsFile   = `bundle.${jsHash}.js`;
  fs.writeFileSync(path.join(DIST, 'js', jsFile), jsResult.code);

  // Minify CSS — hashed filename for index.html cache-busting
  const css       = fs.readFileSync(path.join(SRC, 'css', 'style.css'), 'utf8');
  const cssResult = await esbuild.transform(css, { minify: true, loader: 'css' });
  const cssHash   = hash8(cssResult.code);
  const cssFile   = `style.${cssHash}.css`;
  fs.writeFileSync(path.join(DIST, 'css', cssFile), cssResult.code);

  // Keep original filenames for share.html (uses absolute /css/style.css, /js/shared-utils.js)
  fs.copyFileSync(path.join(SRC, 'css', 'style.css'), path.join(DIST, 'css', 'style.css'));
  for (const f of JS_ORDER) {
    fs.copyFileSync(path.join(SRC, 'js', f), path.join(DIST, 'js', f));
  }

  // Patch index.html: swap CSS link and collapse all script tags into the bundle
  let html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
  html = html
    .replace('href="css/style.css"', `href="css/${cssFile}"`)
    .replace(/[ \t]*<script src="js\/(shared-utils|theme|ui-helpers|api|ui|confetti)\.js"><\/script>\r?\n/g, '')
    .replace('  <script src="js/app.js"></script>', `  <script src="js/${jsFile}"></script>`);
  fs.writeFileSync(path.join(DIST, 'index.html'), html);

  // Patch sw.js: bump cache name (forces old SWs to re-fetch) and update shell assets
  let sw = fs.readFileSync(path.join(SRC, 'sw.js'), 'utf8');
  sw = sw
    .replace("'cardboard-v2'", `'cardboard-${jsHash}'`)
    .replace(
      /const SHELL_ASSETS = \[[\s\S]*?\];/,
      `const SHELL_ASSETS = [\n  '/',\n  '/js/${jsFile}',\n  '/css/${cssFile}',\n];`
    );
  fs.writeFileSync(path.join(DIST, 'sw.js'), sw);

  // Copy remaining static assets
  for (const f of ['manifest.json', 'cardboard-icon.png', 'share.html']) {
    const src = path.join(SRC, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(DIST, f));
  }
  copyDir(path.join(SRC, 'fonts'),   path.join(DIST, 'fonts'));
  copyDir(path.join(SRC, 'avatars'), path.join(DIST, 'avatars'));

  const origKb  = (combined.length + css.length) / 1024;
  const builtKb = (jsResult.code.length + cssResult.code.length) / 1024;
  console.log(`Built: js/${jsFile}  css/${cssFile}`);
  console.log(`       ${origKb.toFixed(0)} KB -> ${builtKb.toFixed(0)} KB (${Math.round((1 - builtKb / origKb) * 100)}% smaller)`);
}

function hash8(str) {
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 8);
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
