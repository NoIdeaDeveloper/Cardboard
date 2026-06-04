#!/usr/bin/env node
'use strict';

const esbuild = require('esbuild');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');

const SRC  = 'frontend';
const DIST = path.join(SRC, 'dist');

// Classic (non-module) scripts, concatenated in load order and exposed as
// globals. app.js is bundled separately (ES-module entry) and references these
// globals ambiently — see the app bundle in main().
const CLASSIC_JS = [
  'shared-utils.js', 'theme.js', 'ui-helpers.js',
  'api.js', 'ui.js', 'confetti.js',
];

async function main() {
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIST, 'js'),  { recursive: true });
  fs.mkdirSync(path.join(DIST, 'css'), { recursive: true });

  // 1. Classic scripts → one concatenated, minified global bundle.
  const combined = CLASSIC_JS
    .map(f => fs.readFileSync(path.join(SRC, 'js', f), 'utf8'))
    .join('\n');
  const jsResult = await esbuild.transform(combined, { minify: true, loader: 'js' });
  const jsHash   = hash8(jsResult.code);
  const jsFile   = `bundle.${jsHash}.js`;
  fs.writeFileSync(path.join(DIST, 'js', jsFile), jsResult.code);

  // 2. app.js → its own bundled IIFE (ES-module entry). bundle:true follows any
  //    imports app.js gains as it is decomposed into app/ submodules; today it
  //    has none. It references the classic globals (escapeHtml, API,
  //    buildGameCard, …) ambiently, so it MUST load after the classic bundle.
  const appBuild = await esbuild.build({
    entryPoints: [path.join(SRC, 'js', 'app.js')],
    bundle: true,
    format: 'iife',
    minify: true,
    write: false,
  });
  const appCode = appBuild.outputFiles[0].text;
  const appHash = hash8(appCode);
  const appFile = `app.${appHash}.js`;
  fs.writeFileSync(path.join(DIST, 'js', appFile), appCode);

  // Minify CSS — hashed filename for index.html cache-busting
  const css       = fs.readFileSync(path.join(SRC, 'css', 'style.css'), 'utf8');
  const cssResult = await esbuild.transform(css, { minify: true, loader: 'css' });
  const cssHash   = hash8(cssResult.code);
  const cssFile   = `style.${cssHash}.css`;
  fs.writeFileSync(path.join(DIST, 'css', cssFile), cssResult.code);

  // Keep original filenames for share.html (uses absolute /css/style.css, /js/shared-utils.js)
  fs.copyFileSync(path.join(SRC, 'css', 'style.css'), path.join(DIST, 'css', 'style.css'));
  for (const f of CLASSIC_JS) {
    fs.copyFileSync(path.join(SRC, 'js', f), path.join(DIST, 'js', f));
  }
  // theme-init.js loads (unhashed) from <head> before paint, so it is served
  // as-is rather than folded into a hashed bundle.
  fs.copyFileSync(path.join(SRC, 'js', 'theme-init.js'), path.join(DIST, 'js', 'theme-init.js'));

  // Patch index.html: swap CSS link and collapse all script tags into the bundle
  let html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
  html = html
    .replace('href="css/style.css"', `href="css/${cssFile}"`)
    .replace(/[ \t]*<script src="js\/(shared-utils|theme|ui-helpers|api|ui|confetti)\.js"><\/script>\r?\n/g, '')
    .replace('  <script type="module" src="js/app.js"></script>',
             `  <script src="js/${jsFile}"></script>\n  <script src="js/${appFile}"></script>`);
  fs.writeFileSync(path.join(DIST, 'index.html'), html);

  // Patch sw.js: bump cache name (forces old SWs to re-fetch) and update shell assets
  let sw = fs.readFileSync(path.join(SRC, 'sw.js'), 'utf8');
  sw = sw
    .replace("'cardboard-v2'", `'cardboard-${jsHash}${appHash}'`)
    .replace(
      /const SHELL_ASSETS = \[[\s\S]*?\];/,
      `const SHELL_ASSETS = [\n  '/',\n  '/js/theme-init.js',\n  '/js/${jsFile}',\n  '/js/${appFile}',\n  '/css/${cssFile}',\n];`
    );
  fs.writeFileSync(path.join(DIST, 'sw.js'), sw);

  // Copy remaining static assets
  for (const f of ['manifest.json', 'cardboard-icon.png', 'share.html']) {
    const src = path.join(SRC, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(DIST, f));
  }
  copyDir(path.join(SRC, 'fonts'),   path.join(DIST, 'fonts'));
  copyDir(path.join(SRC, 'avatars'), path.join(DIST, 'avatars'));

  const appSrc  = fs.readFileSync(path.join(SRC, 'js', 'app.js'), 'utf8');
  const origKb  = (combined.length + appSrc.length + css.length) / 1024;
  const builtKb = (jsResult.code.length + appCode.length + cssResult.code.length) / 1024;
  console.log(`Built: js/${jsFile}  js/${appFile}  css/${cssFile}`);
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
