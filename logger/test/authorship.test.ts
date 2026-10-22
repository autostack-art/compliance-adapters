/**
 * Copyright (c) 2026 stellar-compliance-kit
 * SPDX-License-Identifier: MIT
 */

import * as path from 'path';
import * as fs from 'fs';

describe('logger package authorship', () => {
  it('should not list Claude as author or contributor', () => {
    const packageJsonPath = path.resolve(__dirname, '..', 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));

    const author = packageJson.author || '';
    const contributors = packageJson.contributors || [];

    expect(author.toLowerCase()).not.toContain('claude');
    contributors.forEach((contributor: string | { name?: string }) => {
      const name = typeof contributor === 'string' ? contributor : (contributor.name || '');
      expect(name.toLowerCase()).not.toContain('claude');
    });
  });

  it('should not contain Claude references in source file headers', () => {
    const srcDir = path.resolve(__dirname, '..', 'src');
    const files = fs.readdirSync(srcDir).filter(f => f.endsWith('.ts'));

    files.forEach(file => {
      const content = fs.readFileSync(path.join(srcDir, file), 'utf-8');
      expect(content.toLowerCase()).not.toContain('claude');
    });
  });
});
