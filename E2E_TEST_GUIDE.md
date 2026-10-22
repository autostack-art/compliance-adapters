# Running End-to-End Tests

This guide explains how to run and debug the end-to-end integration tests locally and in CI.

## Quick Start

### Prerequisites

- Node 20+
- Docker and Docker Compose
- Git (to clone the repo)

### Local Development

```bash
# Install all dependencies (including e2e-tests workspace)
npm install

# Run fast unit tests (all three packages)
npm test

# Run end-to-end test (includes container setup/teardown)
npm run test:e2e
```

The `test:e2e` command:
1. Starts the Stellar testnet container via Docker Compose
2. Waits for RPC to be healthy
3. Runs the integration test suite
4. Stops and cleans up the container

**Expected output:**
```
> npm run test:e2e

> e2e-tests@ start
> docker-compose -f e2e-tests/docker-compose.yml up -d

Creating network "e2e_stellar-test" with driver "bridge"
Creating e2e_soroban-preview_1 ... done

> e2e-tests@ test
> jest --runInBand

 PASS  test/integration.test.ts (12.345 s)
  End-to-End Integration: Contract → Sync → Listener
    ✓ should detect denylist event from sanctions sync through horizon listener (11234 ms)

Test Suites: 1 passed, 1 total
Tests:       1 passed, 1 total

> docker-compose -f e2e-tests/docker-compose.yml down -v
Removing e2e_soroban-preview_1 ... done
```

### Iteration (Keep Container Running)

For faster iteration while developing tests:

```bash
# Terminal 1: Start and keep the container running
npm run test:e2e:start

# Terminal 2: Run tests repeatedly
npm run test:e2e:test-only

# When done, stop the container
npm run test:e2e:stop
```

## CI Integration

The GitHub Actions workflow is configured to:

1. **Unit Tests (fast, always runs)**
   - Lint, build, and run unit tests for all three packages
   - Takes ~5 seconds
   - Runs on every push to main and PR

2. **E2E Tests (slower, runs after unit tests pass)**
   - Depends on: `test-unit` job
   - Runs in a separate job to isolate long-running tests
   - Takes ~30 seconds
   - Runs on every push to main and PR

The jobs are defined in `.github/workflows/ci.yml`. The e2e job:
- Uses Docker to run the testnet container
- Sets up Node.js and installs dependencies
- Runs `npm run test:e2e:ci` (which handles cleanup even on failure)
- Reports pass/fail status

## Test Infrastructure Details

### Docker Compose Setup

**File:** `e2e-tests/docker-compose.yml`

Spins up `stellar/soroban-preview:latest` with:
- RPC port: 8000
- Health check: polls `/soroban/rpc` endpoint
- Volume: persistent ledger state (optional, can be removed)
- Network: `stellar-test` (isolated from host)

### Jest Configuration

**File:** `e2e-tests/jest.config.js`

Key settings:
- `maxWorkers: 1` — Runs tests sequentially (Docker port conflicts if parallel)
- `testTimeout: 60000` — 60 second timeout for real ledger operations
- `testEnvironment: 'node'` — Not browser environment

### RPC Health Checks

**File:** `e2e-tests/test/setup.ts`

`waitForRpcHealth()` function:
- Polls `http://localhost:8000/soroban/rpc` up to 30 times
- Exponential backoff between attempts (1s, 2s, 4s, etc.)
- Throws helpful error if RPC doesn't become ready
- Called before any test setup

## Troubleshooting

### "Container is already running on port 8000"

```bash
# Find and remove the existing container
docker-compose -f e2e-tests/docker-compose.yml down -v

# Or kill the process using the port (macOS/Linux)
lsof -i :8000 | tail -1 | awk '{print $2}' | xargs kill -9
```

### "RPC health check failed after 30 attempts"

The container might not be starting properly. Check logs:

```bash
# View container logs
docker-compose -f e2e-tests/docker-compose.yml logs -f soroban-preview

# Or manually check if RPC is responding
curl -X POST http://localhost:8000/soroban/rpc \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc": "2.0", "method": "getNetwork", "params": [], "id": 1}'
```

Expected response: 200 OK with network info (not 404 or connection refused).

### "Test hangs indefinitely"

If tests hang for >60 seconds, most likely cause is RPC not responding. Check:

```bash
# 1. Is container running?
docker ps | grep soroban

# 2. Is RPC port accessible?
netstat -tuln | grep 8000  # or use netstat for Windows

# 3. Are there any Docker resource limits?
docker system df  # check disk usage
docker stats     # check memory/CPU
```

If tests pass locally but fail in CI, check the GitHub Actions logs for:
- Docker daemon failures
- Network connectivity issues
- Resource constraints on the runner

### Contract Deployment Issues

Currently, the test uses a **placeholder contract ID** since the actual contracts live in a separate `compliance-primitives` repo.

For a fully working e2e test:

1. **Option A: Pre-deploy contracts**
   - Build and deploy contracts to testnet container
   - Pass contract ID via `TEST_CONTRACT_ID` environment variable
   - Test uses the deployed contract

2. **Option B: Inline deployment**
   - Copy WASM files from compliance-primitives repo
   - Implement `deployContract()` in `test/setup.ts`
   - Deploy as part of test setup

Current test structure supports both approaches. See `test/setup.ts` comments for next steps.

## Adding New Test Cases

### Structure

All tests go in `e2e-tests/test/**/*.test.ts` and automatically run via Jest.

### Example: Test allowlist-token sync

```typescript
// e2e-tests/test/allowlist.test.ts
import { TEST_CONFIG, waitForRpcHealth, ... } from './setup';

describe('Allowlist Token Integration', () => {
  it('should sync allowlist addresses to contract', async () => {
    const server = await waitForRpcHealth();
    // ... test implementation
  });
});
```

### Utilities Available

From `test/setup.ts`:

- `waitForRpcHealth()` — Wait for RPC to be ready
- `getOrFundAccount()` — Get account info or throw if not funded
- `submitTransaction()` — Build, sign, and wait for transaction
- `pollForContractEvent()` — Poll for contract events with cursor
- `TEST_CONFIG` — Issuer keypair, network passphrase, etc.

## Running Specific Tests

```bash
# Run a single test file
npm run test:e2e:test-only -- test/allowlist.test.ts

# Run tests matching a pattern
npm run test:e2e:test-only -- --testNamePattern="denylist"

# Run with verbose output
npm run test:e2e:test-only -- --verbose

# Run with coverage
npm run test:e2e:test-only -- --coverage
```

## Performance Notes

- **First run**: ~30-40s (Docker container pull + startup)
- **Subsequent runs**: ~20-30s (container reused)
- **Full CI pipeline**: ~40-50s (unit tests + e2e)

The e2e job only runs after unit tests pass, so total CI time is still reasonable.

## Debugging

### Enable Debug Logging

```bash
# Run with full debug output
DEBUG=* npm run test:e2e:test-only

# Or with specific namespace
DEBUG=horizon-listener npm run test:e2e:test-only
```

### Inspect Container State

While tests are running:

```bash
# In another terminal, connect to container
docker exec -it e2e_soroban-preview_1 bash

# Check ledger state
stellar account info $ISSUER_PUBKEY

# View recent transactions
stellar tx list
```

### Keep Container After Test Failure

To debug test failures, don't remove the container:

```bash
# Start container
npm run test:e2e:start

# Run tests (will fail)
npm run test:e2e:test-only

# Container stays running; inspect and iterate
npm run test:e2e:test-only

# When done
npm run test:e2e:stop
```

## Next Steps

1. **Copy WASM files** from compliance-primitives repo to `e2e-tests/fixtures/`
2. **Implement contract deployment** in `test/setup.ts` if not pre-deployed
3. **Add more test cases** (allowlist sync, jurisdiction flags, event filtering)
4. **Integrate with CI/CD** (may already be done if using the updated .github/workflows/ci.yml)

See `e2e-tests/README.md` for architecture and design details.
