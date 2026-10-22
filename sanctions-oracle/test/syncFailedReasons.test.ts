import { syncSanctionsToDenylist, DenylistWriter } from '../src/sync';
import { MockSanctionsProvider, MOCK_FLAGGED_ADDRESSES } from '../src/mockProvider';
import { Keypair } from '@stellar/stellar-sdk';
import { SanctionsProvider } from '../src/SanctionsProvider';

const FLAGGED_ADDRESS = Object.keys(MOCK_FLAGGED_ADDRESSES)[0];
const CLEAN_ADDRESS = Keypair.random().publicKey();

function makeFakeWriter(): DenylistWriter & { addToDenylist: jest.Mock } {
  return {
    addToDenylist: jest.fn().mockResolvedValue({ hash: 'fakehash' }),
  };
}

describe('SyncResult.failedWithReasons (issue #343)', () => {
  it('pairs each failed address with the message of the error that caused it', async () => {
    const provider: SanctionsProvider = {
      async checkAddress(): Promise<{ flagged: boolean; source: string }> {
        throw new Error('provider unavailable');
      },
    };

    const result = await syncSanctionsToDenylist({
      provider,
      addresses: [FLAGGED_ADDRESS, CLEAN_ADDRESS],
      writer: makeFakeWriter(),
      dryRun: true,
      retry: { maxAttempts: 1, sleepFn: async () => {} },
    });

    expect(result.failed).toEqual([FLAGGED_ADDRESS, CLEAN_ADDRESS]);
    expect(result.failedWithReasons).toEqual([
      { address: FLAGGED_ADDRESS, error: 'provider unavailable' },
      { address: CLEAN_ADDRESS, error: 'provider unavailable' },
    ]);
    // failedWithReasons stays aligned with the backward-compatible failed list.
    expect(result.failedWithReasons.map((f) => f.address)).toEqual(result.failed);
  });

  it('reports a non-Error throw as its stringified value', async () => {
    const provider: SanctionsProvider = {
      async checkAddress(): Promise<{ flagged: boolean; source: string }> {
        // eslint-disable-next-line no-throw-literal
        throw 'string failure';
      },
    };

    const result = await syncSanctionsToDenylist({
      provider,
      addresses: [FLAGGED_ADDRESS],
      writer: makeFakeWriter(),
      dryRun: true,
      retry: { maxAttempts: 1, sleepFn: async () => {} },
    });

    expect(result.failedWithReasons).toEqual([
      { address: FLAGGED_ADDRESS, error: 'string failure' },
    ]);
  });

  it('is empty when every provider check succeeds', async () => {
    const result = await syncSanctionsToDenylist({
      provider: new MockSanctionsProvider(),
      addresses: [FLAGGED_ADDRESS, CLEAN_ADDRESS],
      writer: makeFakeWriter(),
      dryRun: true,
    });

    expect(result.failed).toEqual([]);
    expect(result.failedWithReasons).toEqual([]);
  });
});
