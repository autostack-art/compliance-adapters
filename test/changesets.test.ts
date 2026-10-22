/**
 * Copyright (c) 2026 stellar-compliance-kit
 * SPDX-License-Identifier: MIT
 */

describe('Changesets validation (issue #328)', () => {
  it('root .changeset directory exists', () => {
    // Validates that the changesets infrastructure is in place
    // This ensures PR validation can check for changeset files
    const fs = require('node:fs');
    const path = require('node:path');
    const changesetDir = path.join(__dirname, '..', '.changeset');
    expect(fs.existsSync(changesetDir)).toBe(true);
  });

  it('changeset config.json has required fields', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const configPath = path.join(__dirname, '..', '.changeset', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config).toHaveProperty('changelog');
    expect(config).toHaveProperty('commit');
    expect(config).toHaveProperty('access');
  });

  it('supports changelog generation via @changesets/changelog-github', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const configPath = path.join(__dirname, '..', '.changeset', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.changelog).toContain('@changesets/changelog-github');
  });
});
