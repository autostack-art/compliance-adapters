/// <reference types="jest" />

/**
 * Issue #342: syncSanctionsToDenylist validates that each input address is a
 * well-formed Stellar Ed25519 StrKey before checking it, routing malformed
 * entries into SyncResult.invalid (distinct from `failed`, which is for
 * provider-check failures).
 */

import { Keypair } from '@stellar/stellar-sdk';
import { syncSanctionsToDenylist, DenylistWriter } from '../src/sync';
import { MockSanctionsProvider, MOCK_FLAGGED_ADDRESSES } from '../src/mockProvider';
import { SanctionsProvider } from '../src/SanctionsProvider';

const FLAGGED_ADDRESS = Object.keys(MOCK_FLAGGED_ADDRESSES)[0];
const CLEAN_ADDRESS = Keypair.random().publicKey();

function makeFakeWriter(): DenylistWriter & { addToDenylist: jest.Mock } {
  return { addToDenylist: jest.fn().mockResolvedValue({ hash: 'fakehash' }) };
}

describe('syncSanctionsToDenylist — StrKey validation (issue #342)', () => {
  it('routes malformed addresses into `invalid` and never checks them', async () => {
    const provider = new MockSanctionsProvider();
    const checkSpy = jest.spyOn(provider, 'checkAddress');
    const writer = makeFakeWriter();

    const result = await syncSanctionsToDenylist({
      provider,
      addresses: [
        FLAGGED_ADDRESS,
        'not-a-stellar-address',
        'GTRUNCATED',
        `${CLEAN_ADDRESS}TYPO`,
        CLEAN_ADDRESS,
      ],
      writer,
      dryRun: true,
    });

    expect(result.invalid).toEqual(['not-a-stellar-address', 'GTRUNCATED', `${CLEAN_ADDRESS}TYPO`]);
    expect(result.checked).toBe(2);
    expect(result.flagged).toEqual([FLAGGED_ADDRESS]);
    expect(result.failed).toEqual([]);

    // Only the two valid addresses ever reach the provider.
    expect(checkSpy).toHaveBeenCalledTimes(2);
    expect(checkSpy).toHaveBeenCalledWith(FLAGGED_ADDRESS);
    expect(checkSpy).toHaveBeenCalledWith(CLEAN_ADDRESS);
  });

  it('keeps `invalid` and `failed` distinct', async () => {
    const alwaysFails: SanctionsProvider = {
      async checkAddress(): Promise<{ flagged: boolean; source: string }> {
        throw new Error('provider unavailable');
      },
    };
    const writer = makeFakeWriter();

    const result = await syncSanctionsToDenylist({
      provider: alwaysFails,
      addresses: [CLEAN_ADDRESS, 'clearly-bogus'],
      writer,
      dryRun: true,
      retry: { maxAttempts: 1, sleepFn: async () => {} },
    });

    expect(result.invalid).toEqual(['clearly-bogus']);
    expect(result.failed).toEqual([CLEAN_ADDRESS]);
    expect(result.checked).toBe(1);
  });

  it('never writes an invalid address to the denylist', async () => {
    const provider = new MockSanctionsProvider();
    const writer = makeFakeWriter();

    const result = await syncSanctionsToDenylist({
      provider,
      addresses: [FLAGGED_ADDRESS, 'GBADKEY'],
      writer,
      dryRun: false,
    });

    expect(result.written).toEqual([FLAGGED_ADDRESS]);
    expect(result.invalid).toEqual(['GBADKEY']);
    expect(writer.addToDenylist).toHaveBeenCalledTimes(1);
    expect(writer.addToDenylist).not.toHaveBeenCalledWith('GBADKEY');
  });

  it('returns an empty `invalid` array when every address is well-formed', async () => {
    const provider = new MockSanctionsProvider();
    const writer = makeFakeWriter();

    const result = await syncSanctionsToDenylist({
      provider,
      addresses: [FLAGGED_ADDRESS, CLEAN_ADDRESS],
      writer,
      dryRun: true,
    });

    expect(result.invalid).toEqual([]);
  });

  it('deduplicates before validating so a repeated bad entry is reported once', async () => {
    const provider = new MockSanctionsProvider();
    const writer = makeFakeWriter();

    const result = await syncSanctionsToDenylist({
      provider,
      addresses: ['bogus', 'bogus', CLEAN_ADDRESS],
      writer,
      dryRun: true,
    });

    expect(result.invalid).toEqual(['bogus']);
    expect(result.checked).toBe(1);
  });
});
