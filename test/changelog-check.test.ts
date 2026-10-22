/**
 * Copyright (c) 2026 stellar-compliance-kit
 * SPDX-License-Identifier: MIT
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const script = path.resolve(__dirname, '..', 'scripts', 'check-root-changelog.js');

function run(changelog: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-check-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(script, path.join(root, 'scripts', 'check-root-changelog.js'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), changelog);
  return spawnSync('node', [path.join(root, 'scripts', 'check-root-changelog.js')], {
    encoding: 'utf8',
  });
}

describe('check-root-changelog', () => {
  it('fails when [Unreleased] has notes', () => {
    const result = run('## [Unreleased]\n\n- note\n\n## [1.0.0] - 2024-01-01\n');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[Unreleased] must be empty');
  });

  it('passes when [Unreleased] is empty', () => {
    const result = run('## [Unreleased]\n\n## [1.0.0] - 2024-01-01\n');
    expect(result.status).toBe(0);
  });
});
