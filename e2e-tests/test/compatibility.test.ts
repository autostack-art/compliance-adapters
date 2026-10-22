/**
 * SDK compatibility tests.
 *
 * These tests intentionally exercise the public package boundaries together
 * without requiring Docker or a live network. CI runs this file once for each
 * supported @stellar/stellar-sdk minor version.
 */

import http from 'http';
import type { AddressInfo } from 'net';
import {
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk';
import { generateChallenge, verifyChallenge } from 'sep10-auth';
import {
  syncSanctionsToDenylist,
  MockSanctionsProvider,
  createRpcDenylistWriter,
} from 'sanctions-oracle';
import { HorizonListener, RpcEventSource } from 'horizon-listener';

type JsonRpcHandler = (params: any) => unknown;

/**
 * Minimal JSON-RPC server standing in for Soroban RPC, so the real
 * @stellar/stellar-sdk `rpc.Server` (request building, response parsing,
 * transaction assembly) runs against a canned HTTP endpoint.
 */
async function startMockRpc(handlers: Record<string, JsonRpcHandler>) {
  const calls: Array<{ method: string; params: any }> = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const { id, method, params } = JSON.parse(body);
      calls.push({ method, params });
      const handler = handlers[method];
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify(
          handler
            ? { jsonrpc: '2.0', id, result: handler(params) }
            : { jsonrpc: '2.0', id, error: { code: -32601, message: `no handler for ${method}` } },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('public adapter compatibility across Stellar SDK minors', () => {
  it('generates and verifies a SEP-10 challenge', () => {
    const server = Keypair.random();
    const client = Keypair.random();
    const challenge = generateChallenge(client.publicKey(), server, {
      homeDomain: 'example.com',
      webAuthDomain: 'auth.example.com',
      networkPassphrase: Networks.TESTNET,
    });

    const transaction = TransactionBuilder.fromXDR(challenge.transactionXDR, Networks.TESTNET);
    transaction.sign(client);

    expect(
      verifyChallenge(transaction.toXDR(), {
        serverAccountId: server.publicKey(),
        homeDomains: 'example.com',
        webAuthDomain: 'auth.example.com',
        networkPassphrase: Networks.TESTNET,
      }),
    ).toMatchObject({ valid: true, address: client.publicKey() });
  });

  it('runs the sanctions sync and listener pipeline through public APIs', async () => {
    const address = Keypair.random().publicKey();
    const received: string[] = [];
    const listener = new HorizonListener({
      eventSource: {
        getEvents: async (cursor?: string) => ({
          events: cursor
            ? []
            : [
                {
                  id: 'compatibility-event',
                  contractId: 'CXXX',
                  ledger: 1,
                  topic: ['added'],
                  value: address,
                },
              ],
          nextCursor: 'compatibility-event',
        }),
      },
      onEvent: (event) => {
        received.push(event.id);
        listener.stop();
      },
      pollIntervalMs: 0,
    });

    const result = await syncSanctionsToDenylist({
      provider: new MockSanctionsProvider({ flaggedAddresses: [address] }),
      addresses: [address],
      writer: { addToDenylist: async () => ({ hash: 'compatibility-tx' }) },
    });

    await listener.start();

    expect(result).toMatchObject({
      checked: 1,
      flagged: [address],
      written: [address],
      failed: [],
    });
    expect(received).toEqual(['compatibility-event']);
  });

  describe('real RPC-facing code against a mocked HTTP RPC endpoint', () => {
    const CONTRACT_ID = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';

    it('RpcEventSource parses a getEvents response from the SDK rpc.Server', async () => {
      const topic = nativeToScVal('added', { type: 'symbol' }).toXDR('base64');
      const value = nativeToScVal(Keypair.random().publicKey(), { type: 'address' }).toXDR(
        'base64',
      );
      const rpcServer = await startMockRpc({
        getEvents: () => ({
          events: [
            {
              type: 'contract',
              ledger: 42,
              ledgerClosedAt: '2026-01-01T00:00:00Z',
              contractId: CONTRACT_ID,
              id: '0000000180388626432-0000000001',
              pagingToken: '0000000180388626432-0000000001',
              inSuccessfulContractCall: true,
              txHash: 'a'.repeat(64),
              topic: [topic],
              value,
            },
          ],
          latestLedger: 50,
          cursor: '0000000180388626432-0000000001',
        }),
      });

      try {
        const source = new RpcEventSource({
          rpcUrl: rpcServer.url,
          networkPassphrase: Networks.TESTNET,
          contractIds: [CONTRACT_ID],
          startLedger: 1,
        });
        const { events, nextCursor } = await source.getEvents(undefined);

        expect(rpcServer.calls[0].method).toBe('getEvents');
        expect(rpcServer.calls[0].params.startLedger).toBe(1);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          id: '0000000180388626432-0000000001',
          ledger: 42,
        });
        expect(events[0].topic).toHaveLength(1);
        expect(nextCursor).toBe('0000000180388626432-0000000001');
      } finally {
        await rpcServer.close();
      }
    });

    it('createRpcDenylistWriter prepares, signs and submits through the SDK rpc.Server', async () => {
      const sourceKeypair = Keypair.random();
      const target = Keypair.random().publicKey();

      const accountEntry = xdr.LedgerEntryData.account(
        new xdr.AccountEntry({
          accountId: sourceKeypair.xdrAccountId(),
          balance: xdr.Int64.fromString('1000000000'),
          seqNum: xdr.Int64.fromString('1'),
          numSubEntries: 0,
          inflationDest: null,
          flags: 0,
          homeDomain: '',
          thresholds: Buffer.from([1, 0, 0, 0]),
          signers: [],
          ext: new xdr.AccountEntryExt(0),
        }),
      );
      const sorobanData = new xdr.SorobanTransactionData({
        ext: new xdr.SorobanTransactionDataExt(0),
        resources: new xdr.SorobanResources({
          footprint: new xdr.LedgerFootprint({ readOnly: [], readWrite: [] }),
          instructions: 1000,
          diskReadBytes: 0,
          writeBytes: 0,
        }),
        resourceFee: xdr.Int64.fromString('100'),
      });

      const rpcServer = await startMockRpc({
        getLedgerEntries: () => ({
          entries: [
            {
              key: xdr.LedgerKey.account(
                new xdr.LedgerKeyAccount({ accountId: sourceKeypair.xdrAccountId() }),
              ).toXDR('base64'),
              xdr: accountEntry.toXDR('base64'),
              lastModifiedLedgerSeq: 10,
            },
          ],
          latestLedger: 11,
        }),
        simulateTransaction: () => ({
          latestLedger: 11,
          minResourceFee: '100',
          transactionData: sorobanData.toXDR('base64'),
          results: [{ auth: [], xdr: xdr.ScVal.scvVoid().toXDR('base64') }],
        }),
        sendTransaction: () => ({
          status: 'PENDING',
          hash: 'b'.repeat(64),
          latestLedger: 11,
          latestLedgerCloseTime: '1700000000',
        }),
      });

      try {
        const writer = createRpcDenylistWriter({
          rpcUrl: rpcServer.url,
          networkPassphrase: Networks.TESTNET,
          contractId: CONTRACT_ID,
          sourceKeypair,
          maxRetries: 1,
        });

        const result = await writer.addToDenylist(target);

        expect(result).toEqual({ hash: 'b'.repeat(64) });
        expect(rpcServer.calls.map((c) => c.method)).toEqual(
          expect.arrayContaining(['getLedgerEntries', 'simulateTransaction', 'sendTransaction']),
        );
        const sent = rpcServer.calls.find((c) => c.method === 'sendTransaction')!;
        const submitted = TransactionBuilder.fromXDR(sent.params.transaction, Networks.TESTNET);
        expect(submitted.signatures).toHaveLength(1);
      } finally {
        await rpcServer.close();
      }
    });
  });
});
