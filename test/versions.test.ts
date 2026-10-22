import * as fs from 'fs';
import * as path from 'path';

const ROOT_DIR = path.resolve(__dirname, '..');
const CI_WORKFLOW = path.join(ROOT_DIR, '.github/workflows/ci.yml');
const NVMRC = path.join(ROOT_DIR, '.nvmrc');
const ROOT_PACKAGE_JSON = path.join(ROOT_DIR, 'package.json');

function parseNodeVersionsFromCI(ciContent: string): string[] {
  const match = ciContent.match(/node-version:\s*\[([^\]]+)\]/);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v);
}

function parseNodeVersionsFromMatrixBlock(ciContent: string, jobName: string): string[] {
  const jobMatch = ciContent.match(new RegExp(`${jobName}:[\\s\\S]*?strategy:[\\s\\S]*?matrix:[\\s\\S]*?node-version:\\s*\\[([^\\]]+)\\]`));
  if (!jobMatch) return [];
  return jobMatch[1]
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v);
}

describe('Version consistency checks', () => {
  describe('Issue #332: CI matrix includes multiple Node versions', () => {
    it('should test at least two Node versions in test-unit job', () => {
      const ciContent = fs.readFileSync(CI_WORKFLOW, 'utf8');
      const testUnitVersions = parseNodeVersionsFromMatrixBlock(ciContent, 'test-unit');

      expect(testUnitVersions.length).toBeGreaterThanOrEqual(2);
      expect(testUnitVersions).toContain('20.x');
      expect(testUnitVersions).toContain('22.x');
    });

    it('should test at least two Node versions in test-e2e job', () => {
      const ciContent = fs.readFileSync(CI_WORKFLOW, 'utf8');
      const testE2eVersions = parseNodeVersionsFromMatrixBlock(ciContent, 'test-e2e');

      expect(testE2eVersions.length).toBeGreaterThanOrEqual(2);
    });

    it('should test at least two Node versions in benchmark job', () => {
      const ciContent = fs.readFileSync(CI_WORKFLOW, 'utf8');
      const benchmarkVersions = parseNodeVersionsFromMatrixBlock(ciContent, 'benchmark');

      expect(benchmarkVersions.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Issue #331: Version consistency between .nvmrc, package.json engines, and CI', () => {
    it('.nvmrc should exist and specify a valid Node version', () => {
      expect(fs.existsSync(NVMRC)).toBe(true);
      const nvmrcContent = fs.readFileSync(NVMRC, 'utf8').trim();
      expect(nvmrcContent).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('should parse .nvmrc version correctly', () => {
      const nvmrcContent = fs.readFileSync(NVMRC, 'utf8').trim();
      const majorVersion = parseInt(nvmrcContent.split('.')[0], 10);
      expect(majorVersion).toBeGreaterThanOrEqual(20);
    });

    it('root package.json engines.node should specify supported versions', () => {
      const pkgJson = JSON.parse(fs.readFileSync(ROOT_PACKAGE_JSON, 'utf8'));
      expect(pkgJson.engines).toBeDefined();
      expect(pkgJson.engines.node).toBeDefined();
      expect(pkgJson.engines.node).toContain('>=');
    });

    it('CI matrix should include the major version from .nvmrc', () => {
      const nvmrcContent = fs.readFileSync(NVMRC, 'utf8').trim();
      const majorVersion = parseInt(nvmrcContent.split('.')[0], 10);

      const ciContent = fs.readFileSync(CI_WORKFLOW, 'utf8');
      const testUnitVersions = parseNodeVersionsFromMatrixBlock(ciContent, 'test-unit');

      const expectedVersion = `${majorVersion}.x`;
      expect(testUnitVersions).toContain(expectedVersion);
    });
  });
});
