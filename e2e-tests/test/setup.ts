/**
 * E2E Test Setup Helpers
 *
 * Handles:
 * - RPC health checks and waits
 * - Test account funding
 * - Contract deployment (if needed; pre-built WASMs committed to repo)
 * - Network configuration
 */

import * as fs from 'fs';
import {
  Keypair,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
  rpc,
  Address,
  Operation,
} from '@stellar/stellar-sdk';

/**
 * Configuration for the local testnet.
 * Matches docker-compose.yml environment (stellar/quickstart running with
 * `--local --enable-soroban-rpc`).
 */
export const TEST_CONFIG = {
  rpcUrl: 'http://localhost:8000/soroban/rpc',
  friendbotUrl: 'http://localhost:8000/friendbot',
  horizonUrl: 'http://localhost:8000',
  networkPassphrase: 'Standalone Network ; February 2017',

  // Throwaway test keypair, freshly funded via friendbot on every run against
  // an ephemeral local network. Generated at setup time so no secret key is
  // ever committed to source control; set E2E_ISSUER_SECRET to pin a stable
  // identity instead (e.g. from the docker-compose test harness).
  issuer: process.env.E2E_ISSUER_SECRET
    ? Keypair.fromSecret(process.env.E2E_ISSUER_SECRET)
    : Keypair.random(),

  // A syntactically valid (real checksum) Stellar address to submit through
  // the real on-chain add_to_denylist call. sanctions-oracle's
  // MOCK_FLAGGED_ADDRESSES are checksum-invalid placeholders (fine for
  // off-chain provider matching in unit tests, but rejected by the SDK's
  // Address/StrKey validation when building an on-chain transaction) — this
  // e2e test passes this address to MockSanctionsProvider explicitly instead.
  flaggedAddress: 'GBPRXLMJ4EE23ARCDREURT57NDZIVHJWTZNB4ZWDMH2DKAP5Z4B5LWMD',

  // Timeouts
  rpcHealthCheckTimeoutMs: 30000,
  txSubmitTimeoutMs: 30000,
  eventPollTimeoutMs: 30000,
};

/**
 * Create an rpc.Server for the given URL, allowing plain http:// for local
 * test networks (the SDK refuses insecure URLs unless opted in explicitly).
 */
function createServer(rpcUrl: string): rpc.Server {
  return new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });
}

/**
 * Wait for RPC to be healthy and responding.
 * Retries with exponential backoff up to maxAttempts.
 */
export async function waitForRpcHealth(
  maxAttempts: number = 30,
  delayMs: number = 1000,
): Promise<rpc.Server> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const server = createServer(TEST_CONFIG.rpcUrl);
      // Make a simple RPC call to verify connectivity
      const response = await server.getNetwork();
      console.log(`✓ RPC healthy at attempt ${attempt}, network:`, response);
      return server;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxAttempts) {
        console.log(
          `⏳ RPC not ready (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs}ms...`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw new Error(
    `RPC health check failed after ${maxAttempts} attempts. Last error: ${lastError?.message}`,
  );
}

/**
 * Fund a test account with native asset via the soroban-preview/quickstart
 * container's built-in friendbot endpoint, then wait for the funding
 * transaction to land so the account is immediately usable.
 */
export async function fundAccount(server: rpc.Server, keypair: Keypair): Promise<void> {
  try {
    await server.getAccount(keypair.publicKey());
    console.log(`✓ Account ${keypair.publicKey()} already funded`);
    return;
  } catch (err) {
    // Account doesn't exist yet; fall through and fund it below.
  }

  console.log(`⏳ Funding account ${keypair.publicKey()} via friendbot...`);
  // Friendbot can 502 for a few seconds after the RPC endpoint itself starts
  // responding (they come up on slightly different schedules inside the
  // container), so retry transient failures instead of failing immediately.
  const friendbotUrl = `${TEST_CONFIG.friendbotUrl}?addr=${encodeURIComponent(keypair.publicKey())}`;
  let lastError: string | undefined;
  let funded = false;
  for (let attempt = 1; attempt <= 10 && !funded; attempt++) {
    const response = await fetch(friendbotUrl);
    if (response.ok) {
      funded = true;
      break;
    }
    lastError = `${response.status} ${response.statusText} ${await response.text().catch(() => '')}`;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!funded) {
    throw new Error(`Friendbot funding failed for ${keypair.publicKey()}: ${lastError}`);
  }

  // Friendbot returns as soon as the funding transaction is submitted, not
  // once it's finalized; poll until the account is actually visible via RPC.
  const startTime = Date.now();
  while (Date.now() - startTime < TEST_CONFIG.txSubmitTimeoutMs) {
    try {
      await server.getAccount(keypair.publicKey());
      console.log(`✓ Account ${keypair.publicKey()} funded`);
      return;
    } catch (err) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  throw new Error(
    `Account ${keypair.publicKey()} still not visible via RPC ${TEST_CONFIG.txSubmitTimeoutMs}ms after friendbot funding.`,
  );
}

/**
 * Get or create a test account, funding it via friendbot if it doesn't exist yet.
 */
export async function getOrFundAccount(
  server: rpc.Server,
  keypair: Keypair,
): Promise<{ pubkey: string; sequence: string; balance: string }> {
  try {
    return await readAccountSummary(server, keypair);
  } catch (err) {
    // Not found; fund it and read the summary again.
  }

  await fundAccount(server, keypair);
  return readAccountSummary(server, keypair);
}

async function readAccountSummary(
  server: rpc.Server,
  keypair: Keypair,
): Promise<{ pubkey: string; sequence: string; balance: string }> {
  const account = await server.getAccount(keypair.publicKey());
  return {
    pubkey: keypair.publicKey(),
    sequence: account.sequenceNumber(),
    balance: await fetchNativeBalance(keypair.publicKey()),
  };
}

/**
 * Soroban RPC's getAccount() only returns enough of the account to build
 * transactions (id + sequence number), not its balances; read those from
 * the container's bundled Horizon instead (same host, REST API).
 */
async function fetchNativeBalance(publicKey: string): Promise<string> {
  const response = await fetch(`${TEST_CONFIG.horizonUrl}/accounts/${publicKey}`);
  if (!response.ok) return '0';
  const account = (await response.json()) as {
    balances?: { asset_type: string; balance: string }[];
  };
  return account.balances?.find((b) => b.asset_type === 'native')?.balance ?? '0';
}

/**
 * Deploy a prebuilt Soroban contract WASM.
 *
 * Assumes the WASM is already in e2e-tests/fixtures/ and committed to the repo
 * (see e2e-tests/fixtures/README.md). This function does NOT build the
 * contract; it uploads and instantiates a pre-built artifact via two
 * transactions: upload the WASM, then create a contract instance from it.
 */
export async function deployContract(
  server: rpc.Server,
  issuerKeypair: Keypair,
  wasmPath: string,
): Promise<{ contractId: string; deployTxHash: string }> {
  let wasm: Buffer;
  try {
    wasm = fs.readFileSync(wasmPath);
  } catch (err) {
    throw new Error(
      `Could not read contract WASM at ${wasmPath}. ` +
        `See e2e-tests/fixtures/README.md for how to build/obtain it. ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }

  console.log(`⏳ Uploading contract WASM (${wasm.byteLength} bytes)...`);
  const uploadAccount = await server.getAccount(issuerKeypair.publicKey());
  const uploadTx = new TransactionBuilder(uploadAccount, {
    fee: BASE_FEE,
    networkPassphrase: TEST_CONFIG.networkPassphrase,
  })
    .addOperation(Operation.uploadContractWasm({ wasm }))
    .setTimeout(30)
    .build();

  const uploadResult = await submitPreparedTransaction(server, uploadTx, issuerKeypair);
  const wasmHash = scValToNative(uploadResult.returnValue) as Buffer;
  console.log(`✓ WASM uploaded, hash: ${wasmHash.toString('hex')}`);

  console.log(`⏳ Creating contract instance...`);
  const createAccount = await server.getAccount(issuerKeypair.publicKey());
  const createTx = new TransactionBuilder(createAccount, {
    fee: BASE_FEE,
    networkPassphrase: TEST_CONFIG.networkPassphrase,
  })
    .addOperation(
      Operation.createCustomContract({
        address: new Address(issuerKeypair.publicKey()),
        wasmHash,
      }),
    )
    .setTimeout(30)
    .build();

  const createResult = await submitPreparedTransaction(server, createTx, issuerKeypair);
  const contractId = scValToNative(createResult.returnValue) as string;
  console.log(`✓ Contract deployed: ${contractId}`);

  return { contractId, deployTxHash: createResult.txHash };
}

/**
 * Simulate, sign, submit, and wait for finalization of a transaction that
 * invokes a host function (upload/create/invoke contract). Returns the
 * finalized transaction's return value along with its hash.
 */
async function submitPreparedTransaction(
  server: rpc.Server,
  tx: ReturnType<TransactionBuilder['build']>,
  signer: Keypair,
): Promise<{ returnValue: ReturnType<typeof nativeToScVal>; txHash: string }> {
  let prepared;
  try {
    prepared = await server.prepareTransaction(tx);
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to prepare transaction (simulation error): ${err}`);
  }

  prepared.sign(signer);
  const sendResult = await server.sendTransaction(prepared);
  const txHash = sendResult.hash;

  if (sendResult.status === 'ERROR') {
    throw new Error(`Transaction submission failed: ${JSON.stringify(sendResult.errorResult)}`);
  }

  const startTime = Date.now();
  while (Date.now() - startTime < 30000) {
    const getResult = await server.getTransaction(txHash);
    if (getResult.status === 'SUCCESS') {
      return { returnValue: getResult.returnValue as ReturnType<typeof nativeToScVal>, txHash };
    }
    if (getResult.status === 'FAILED') {
      throw new Error(`Transaction failed: ${txHash}, result: ${JSON.stringify(getResult)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Transaction ${txHash} not finalized within 30000ms`);
}

/**
 * Wait for a transaction to be finalized on the ledger.
 * Returns the final transaction result or throws if timeout/not found.
 */
export async function waitForTransactionFinalization(
  server: rpc.Server,
  txHash: string,
  maxWaitMs: number = 30000,
  pollIntervalMs: number = 500,
): Promise<{ ledger: number; envelope: unknown }> {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const response = await server.getTransaction(txHash);
      if (response.status === 'SUCCESS') {
        console.log(`✓ Transaction finalized: ${txHash}, ledger:`, response.ledger);
        return { ledger: response.ledger, envelope: response.envelopeXdr };
      }
      if (response.status === 'FAILED') {
        throw new Error(`Transaction failed: ${txHash}, reason: ${response.resultXdr}`);
      }
      // status === 'PENDING', wait a bit more
    } catch (err) {
      if (err instanceof Error && err.message.includes('Transaction not found')) {
        // Not yet finalized, continue polling
      } else {
        throw err;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`Transaction ${txHash} not finalized within ${maxWaitMs}ms`);
}

/**
 * Submit and wait for a transaction to finalize.
 */
export async function submitTransaction(
  server: rpc.Server,
  tx: TransactionBuilder,
  signer: Keypair,
  timeoutMs: number = 30000,
): Promise<{ hash: string; ledger: number }> {
  // Build and sign the transaction
  const built = tx.build();
  built.sign(signer);

  // Submit to RPC
  const response = await server.sendTransaction(built);
  const hash = response.hash;

  console.log(`📤 Transaction submitted: ${hash}`);

  // Wait for finalization
  const { ledger } = await waitForTransactionFinalization(server, hash, timeoutMs);

  console.log(`✓ Transaction finalized at ledger ${ledger}`);
  return { hash, ledger };
}

/**
 * Helper to poll for a contract event with a cursor.
 * Used by tests to verify denylist-gate events are emitted.
 */
export async function pollForContractEvent(
  server: rpc.Server,
  contractId: string,
  options: {
    cursor?: string;
    timeout?: number;
    pollInterval?: number;
  } = {},
): Promise<{
  events: { id: string; topic: string[]; value: unknown; ledger: number }[];
  nextCursor: string;
}> {
  const { timeout = 30000, pollInterval = 500 } = options;
  const startTime = Date.now();
  let cursor = options.cursor;

  while (Date.now() - startTime < timeout) {
    try {
      let request: Parameters<typeof server.getEvents>[0];
      if (cursor) {
        request = {
          cursor,
          filters: [{ type: 'contract', contractIds: [contractId] }],
        };
      } else {
        // Soroban RPC rejects startLedger: 0 ("must be positive") and requires
        // it to be within the node's retention window; use the current ledger
        // as a safe starting point for a cursor-less call.
        const { sequence: latestLedger } = await server.getLatestLedger();
        request = {
          startLedger: latestLedger,
          filters: [{ type: 'contract', contractIds: [contractId] }],
        };
      }

      // Type gymnastics to satisfy the SDK's generic types
      const rawResponse = await (server.getEvents as (req: unknown) => Promise<unknown>)(request);

      const response = rawResponse as {
        events?: Array<{
          id: string;
          topic?: unknown[];
          value: unknown;
          ledger: number;
        }>;
        cursor?: string;
      };

      const events = (response.events ?? []).map((e) => ({
        id: e.id,
        topic: (e.topic ?? []).map((t) => String(scValToNative(t as never))),
        value: scValToNative(e.value as never),
        ledger: e.ledger,
      }));

      const nextCursor =
        response.cursor ?? (events.length > 0 ? events[events.length - 1].id : (cursor ?? ''));

      if (events.length > 0) {
        console.log(`✓ Found ${events.length} contract events`);
        return { events, nextCursor };
      }

      cursor = nextCursor;
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    } catch (err) {
      console.warn(`⚠ Error polling for events:`, err instanceof Error ? err.message : String(err));
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
  }

  throw new Error(`No contract events found for ${contractId} within ${timeout}ms`);
}
