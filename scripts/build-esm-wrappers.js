#!/usr/bin/env node
// Generates ESM entry points (dist/<entry>.mjs + .d.mts) that re-export the
// CommonJS build, following Node's "ESM wrapper" dual-package pattern. A single
// CJS implementation avoids the dual-package hazard while giving ESM consumers
// named imports and an `import` condition in each package's exports map.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const pkgDir = path.resolve(process.argv[2] || '.');
const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
const IDENT = /^[A-Za-z_$][\w$]*$/;

for (const target of Object.values(pkg.exports || {})) {
  const esm = target && target.import;
  if (!esm) continue;
  const cjsFile = path.join(pkgDir, target.require.default);
  const base = './' + path.basename(cjsFile);
  const names = Object.keys(require(cjsFile)).filter(
    (n) => n !== 'default' && n !== '__esModule' && IDENT.test(n),
  );
  const js = [
    `import cjs from '${base}';`,
    names.length ? `export const { ${names.join(', ')} } = cjs;` : '',
    'export default cjs;',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(pkgDir, esm.default), js);
  fs.writeFileSync(path.join(pkgDir, esm.types), `export * from '${base}';\n`);
}
