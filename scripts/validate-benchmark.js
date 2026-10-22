/**
 * Copyright (c) 2026 stellar-compliance-kit
 * SPDX-License-Identifier: MIT
 */

const fs = require('fs');
const path = require('path');

function argValue(flag, defaultValue) {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index === process.argv.length - 1) return defaultValue;
  return process.argv[index + 1];
}

function parseBenchmarkResult(logContent) {
  const marker = 'BENCHMARK_RESULT_JSON=';
  const line = logContent
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(marker));

  if (!line) {
    throw new Error('Missing BENCHMARK_RESULT_JSON marker in benchmark log output.');
  }

  const payload = line.slice(marker.length);
  return JSON.parse(payload);
}

function loadJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeSummary(summaryPath, lines) {
  if (!summaryPath) return;
  fs.writeFileSync(summaryPath, `${lines.join('\n')}\n`, 'utf8');
}

function main() {
  const logFile = argValue('--log-file');
  const baselineFile = argValue('--baseline-file');
  const thresholdPercent = Number(argValue('--threshold-percent', '20'));
  const summaryFile = argValue('--summary-file');

  if (!logFile || !baselineFile) {
    throw new Error(
      'Usage: node scripts/validate-benchmark.js --log-file <path> --baseline-file <path> [--threshold-percent 20] [--summary-file <path>]',
    );
  }

  const logPath = path.resolve(logFile);
  const baselinePath = path.resolve(baselineFile);

  const result = parseBenchmarkResult(fs.readFileSync(logPath, 'utf8'));
  const baseline = loadJsonFile(baselinePath);

  if (baseline.benchmark !== result.benchmark) {
    throw new Error(
      `Benchmark mismatch: baseline=${baseline.benchmark} result=${result.benchmark}`,
    );
  }

  const baselineOps = Number(baseline.opsPerSecond);
  const actualOps = Number(result.opsPerSecond);
  const allowedFloor = baselineOps * (1 - thresholdPercent / 100);
  const changePercent = ((actualOps - baselineOps) / baselineOps) * 100;

  const summary = [
    '## SEP-10 Challenge Throughput Benchmark',
    `Benchmark completed on: ${new Date().toISOString()}`,
    `- Baseline ops/sec: ${baselineOps.toFixed(1)}`,
    `- Current ops/sec: ${actualOps.toFixed(1)}`,
    `- Allowed regression threshold: ${thresholdPercent}%`,
    `- Allowed floor: ${allowedFloor.toFixed(1)} ops/sec`,
    `- Change vs baseline: ${changePercent.toFixed(1)}%`,
  ];

  if (actualOps < allowedFloor) {
    summary.push(
      '',
      `:x: Throughput regression detected. Current ops/sec (${actualOps.toFixed(1)}) is below allowed floor (${allowedFloor.toFixed(1)}).`,
    );
    writeSummary(summaryFile, summary);
    throw new Error(
      `Throughput regression detected: ${actualOps.toFixed(1)} < ${allowedFloor.toFixed(1)} ops/sec`,
    );
  }

  summary.push('', ':white_check_mark: Throughput is within the accepted range.');
  writeSummary(summaryFile, summary);
  console.log(
    `Benchmark check passed: ${actualOps.toFixed(1)} ops/sec (baseline ${baselineOps.toFixed(1)}, threshold ${thresholdPercent}%)`,
  );
}

main();
