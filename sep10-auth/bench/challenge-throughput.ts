import { Keypair } from '@stellar/stellar-sdk';
import { generateChallenge } from '../src/challenge';

// Measures how many generateChallenge calls per second are achievable, so a
// regression in the SDK's WebAuth.buildChallengeTx cost profile is visible
// as a throughput drop rather than a silent slowdown.

const DURATION_MS = 2000;

interface BenchmarkResult {
  benchmark: 'sep10-auth-generate-challenge-throughput';
  durationMs: number;
  iterations: number;
  opsPerSecond: number;
  timestamp: string;
}

function runBenchmark(): BenchmarkResult {
  const serverKeypair = Keypair.random();
  const clientKeypair = Keypair.random();
  const clientAddress = clientKeypair.publicKey();

  let iterations = 0;
  const start = Date.now();
  let elapsed = 0;

  while (elapsed < DURATION_MS) {
    generateChallenge(clientAddress, serverKeypair, {
      homeDomain: 'example.com',
      webAuthDomain: 'example.com',
    });
    iterations += 1;
    elapsed = Date.now() - start;
  }

  const opsPerSecond = Number((iterations / (elapsed / 1000)).toFixed(1));
  return {
    benchmark: 'sep10-auth-generate-challenge-throughput',
    durationMs: elapsed,
    iterations,
    opsPerSecond,
    timestamp: new Date().toISOString(),
  };
}

function printResult(result: BenchmarkResult): void {
  console.log(
    `generateChallenge: ${result.iterations} calls in ${result.durationMs}ms (${result.opsPerSecond.toFixed(1)} ops/sec)`,
  );
  // Machine-readable marker consumed by CI regression checks.
  console.log(`BENCHMARK_RESULT_JSON=${JSON.stringify(result)}`);
}

const result = runBenchmark();
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(result));
} else {
  printResult(result);
}
