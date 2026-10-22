/**
 * Copyright (c) 2026 stellar-compliance-kit
 * SPDX-License-Identifier: MIT
 */

const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');

// Derive packages from the root workspaces so new workspace packages are picked
// up automatically; those without a coverage summary are skipped with a warning.
const rootPkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const packages = rootPkg.workspaces || [];

let totalStmts = { covered: 0, total: 0 };
let totalBranch = { covered: 0, total: 0 };
let totalFuncs = { covered: 0, total: 0 };
let totalLines = { covered: 0, total: 0 };

const rows = [];

for (const pkg of packages) {
  const summaryPath = path.join(rootDir, pkg, 'coverage', 'coverage-summary.json');
  if (!fs.existsSync(summaryPath)) {
    console.warn(`Warning: Coverage summary not found for ${pkg} at ${summaryPath}`);
    continue;
  }

  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const total = summary.total;

  if (!total) continue;

  totalStmts.covered += total.statements.covered;
  totalStmts.total += total.statements.total;

  totalBranch.covered += total.branches.covered;
  totalBranch.total += total.branches.total;

  totalFuncs.covered += total.functions.covered;
  totalFuncs.total += total.functions.total;

  totalLines.covered += total.lines.covered;
  totalLines.total += total.lines.total;

  rows.push({
    pkg,
    stmtsPct: `${total.statements.pct}% (${total.statements.covered}/${total.statements.total})`,
    branchPct: `${total.branches.pct}% (${total.branches.covered}/${total.branches.total})`,
    funcsPct: `${total.functions.pct}% (${total.functions.covered}/${total.functions.total})`,
    linesPct: `${total.lines.pct}% (${total.lines.covered}/${total.lines.total})`,
  });
}

function calcPct(metrics) {
  if (metrics.total === 0) return '0%';
  const pct = ((metrics.covered / metrics.total) * 100).toFixed(2);
  return `${pct}% (${metrics.covered}/${metrics.total})`;
}

const overallStmts = calcPct(totalStmts);
const overallBranch = calcPct(totalBranch);
const overallFuncs = calcPct(totalFuncs);
const overallLines = calcPct(totalLines);

let markdown = `## 📊 Combined Code Coverage Report\n\n`;
markdown += `| Package | Statements | Branches | Functions | Lines |\n`;
markdown += `| :--- | :--- | :--- | :--- | :--- |\n`;

for (const r of rows) {
  markdown += `| **${r.pkg}** | ${r.stmtsPct} | ${r.branchPct} | ${r.funcsPct} | ${r.linesPct} |\n`;
}

markdown += `| **Combined Total** | **${overallStmts}** | **${overallBranch}** | **${overallFuncs}** | **${overallLines}** |\n`;

console.log(markdown);

const summaryFile = process.env.GITHUB_STEP_SUMMARY;
if (summaryFile) {
  fs.appendFileSync(summaryFile, markdown, 'utf8');
  console.log('Appended coverage report to $GITHUB_STEP_SUMMARY.');
}
