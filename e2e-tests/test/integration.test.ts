/**
 * End-to-End Integration Test
 *
 * Full round-trip: deploy contract → sync flagged address to denylist →
 * verify the contract actually recorded it and emitted the expected event.
 *
 * This test proves sanctions-oracle and a real deployed Soroban contract
 * actually interoperate beyond isolated unit test mocks. It runs entirely
 * against the local stellar/quickstart container started by
 * docker-compose.yml — no pre-set TEST_CONTRACT_ID or manually-funded
 * account is required; deployment and funding both happen here.
 *
 * horizon-listener's cursor/backoff polling behavior is exercised separately
 * against a synthetic event source below — that isolates listener mechanics
 * from the real network so it stays deterministic and fast.
 */

import * as path from 'path';
import { Keypair } from '@stellar/stellar-sdk';
import {
  syncSanctionsToDenylist,
  createRpcDenylistWriter,
  MockSanctionsProvider,
} from 'sanctions-oracle';
import { HorizonListener } from 'horizon-listener';
import {
  TEST_CONFIG,
  waitForRpcHealth,
  getOrFundAccount,
  deployContract,
  pollForContractEvent,
} from './setup';

const WASM_PATH = path.join(__dirname, '..', 'fixtures', 'denylist-gate.wasm');

describe('End-to-End Integration: Contract → Sync → Listener', () => {
  it('deploys a contract, syncs a flagged address to it, and observes the resulting event', async () => {
    // =========================================================================
    // SETUP: RPC health, funded account, deployed contract
    // =========================================================================
    console.log('\n1. Checking RPC health...');
    const server = await waitForRpcHealth();

    console.log('\n2. Funding test account (if needed)...');
    const account = await getOrFundAccount(server, TEST_CONFIG.issuer);
    console.log('✓ Account ready:', {
      pubkey: account.pubkey.substring(0, 10) + '...',
      balance: account.balance,
      sequence: account.sequence,
    });

    console.log('\n3. Resolving contract...');
    const contractId =
      process.env.TEST_CONTRACT_ID ??
      (await deployContract(server, TEST_CONFIG.issuer, WASM_PATH)).contractId;
    console.log(`✓ Using contract: ${contractId}`);

    // =========================================================================
    // STEP 1: sanctions-oracle sync writes the flagged address on-chain
    // =========================================================================
    console.log('\n4. Running sanctions-oracle sync against the deployed contract...');
    const provider = new MockSanctionsProvider({ flaggedAddresses: [TEST_CONFIG.flaggedAddress] });
    const writer = createRpcDenylistWriter({
      rpcUrl: TEST_CONFIG.rpcUrl,
      networkPassphrase: TEST_CONFIG.networkPassphrase,
      contractId,
      sourceKeypair: TEST_CONFIG.issuer,
    });

    const syncResult = await syncSanctionsToDenylist({
      provider,
      addresses: [TEST_CONFIG.flaggedAddress],
      writer,
      dryRun: false,
    });

    expect(syncResult.flagged).toEqual([TEST_CONFIG.flaggedAddress]);
    expect(syncResult.written).toEqual([TEST_CONFIG.flaggedAddress]);
    expect(syncResult.failed).toEqual([]);
    console.log('✓ Sync wrote the flagged address to the contract:', syncResult);

    // =========================================================================
    // STEP 2: Verify the contract actually emitted a denylist_added event
    // =========================================================================
    console.log('\n5. Polling for the on-chain contract event...');
    const { events } = await pollForContractEvent(server, contractId, { timeout: 20000 });

    expect(events.length).toBeGreaterThan(0);
    const event = events[events.length - 1];
    expect(event.topic).toContain('denylist_added');
    expect(event.value).toBe(TEST_CONFIG.flaggedAddress);
    console.log('✓ Contract emitted the expected event:', event);

    // =========================================================================
    // STEP 3: Exercise horizon-listener's cursor/backoff polling logic
    // =========================================================================
    // Uses a synthetic event source (rather than RpcEventSource against this
    // contract) so listener mechanics are verified deterministically and
    // independently of real ledger timing.
    console.log('\n6. Testing horizon-listener polling logic...');
    const receivedEvents: Array<{ topic: string[] }> = [];

    const listener = new HorizonListener({
      eventSource: {
        getEvents: async (cursor?: string) => {
          const mockEvent = {
            id: 'evt-denylist-1',
            contractId,
            ledger: event.ledger,
            topic: ['denylist_added'],
            value: { address: TEST_CONFIG.flaggedAddress },
          };

          return {
            events: cursor ? [] : [mockEvent],
            nextCursor: 'evt-denylist-1',
          };
        },
      },
      onEvent: (evt) => {
        receivedEvents.push(evt as { topic: string[] });
        if (receivedEvents.length === 1) {
          listener.stop();
        }
      },
      pollIntervalMs: 100,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      backoffOptions: { jitter: false },
    });

    await listener.start();

    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0].topic).toContain('denylist_added');
    console.log('✓ Listener successfully observed and re-emitted event');

    console.log('\n=== E2E Test Completed Successfully ===\n');
  });
});

describe('End-to-End Failure Scenarios', () => {
  it('deployContract rejects with a clear error when the WASM file is missing', async () => {
    const server = await waitForRpcHealth();
    const missingPath = path.join(__dirname, '..', 'fixtures', 'does-not-exist.wasm');

    await expect(deployContract(server, TEST_CONFIG.issuer, missingPath)).rejects.toThrow(
      /Could not read contract WASM/,
    );
  });

  it('deployContract fails fast when the deployer account was never funded', async () => {
    const server = await waitForRpcHealth();
    const unfunded = Keypair.random();

    const started = Date.now();
    await expect(deployContract(server, unfunded, WASM_PATH)).rejects.toThrow();
    // Must surface the error promptly rather than hanging until the 30s finalization timeout.
    expect(Date.now() - started).toBeLessThan(25000);
  });
});
