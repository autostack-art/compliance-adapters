#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const changelogPath = path.join(root, 'CHANGELOG.md');
const packagePath = path.join(root, 'package.json');

const changelog = fs.readFileSync(changelogPath, 'utf8');
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const releaseHeading = new RegExp(
  '^## \\[' + packageJson.version.replaceAll('.', '\\.') + '\\] - \\d{4}-\\d{2}-\\d{2}$',
  'm',
);

if (!releaseHeading.test(changelog)) {
  console.error(
    `CHANGELOG.md must contain a dated ## [${packageJson.version}] release entry.`,
  );
  process.exit(1);
}

const unreleasedSection = changelog.match(/^## \[Unreleased\]([\s\S]*?)(?=^## \[)/m)?.[1] ?? '';
if (unreleasedSection.trim()) {
  console.error(
    'CHANGELOG.md [Unreleased] must be empty when preparing a release; move its notes into the dated release entry.',
  );
  process.exit(1);
}

console.log(`Root CHANGELOG.md contains the ${packageJson.version} release entry.`);
