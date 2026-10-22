import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StrKey } from '@stellar/stellar-sdk';
import { MockSanctionsProvider, MOCK_FLAGGED_ADDRESSES } from '../src/mockProvider';

const KNOWN_FLAGGED_ADDRESS = Object.keys(MOCK_FLAGGED_ADDRESSES)[0];
const KNOWN_UNFLAGGED_ADDRESS = 'GDNOTPRESENTINANYMOCKWATCHLISTAAAAAAAAAAAAAAAAAAAAAAAAAA';

/** Writes `data` as JSON to a fresh temp file and returns its path. */
function writeTempJson(data: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-provider-test-'));
  const filePath = path.join(dir, 'addresses.json');
  fs.writeFileSync(filePath, JSON.stringify(data));
  return filePath;
}

describe('MOCK_FLAGGED_ADDRESSES', () => {
  it('are not valid Ed25519 StrKeys, so they can never collide with a real account', () => {
    for (const address of Object.keys(MOCK_FLAGGED_ADDRESSES)) {
      expect(StrKey.isValidEd25519PublicKey(address)).toBe(false);
    }
  });
});

describe('MockSanctionsProvider.fromFile', () => {
  it('loads the default watchlist when no options are given', async () => {
    const provider = await MockSanctionsProvider.fromFile();
    const result = await provider.checkAddress(KNOWN_FLAGGED_ADDRESS);
    expect(result.flagged).toBe(true);
    expect(result.source).toBe(MOCK_FLAGGED_ADDRESSES[KNOWN_FLAGGED_ADDRESS]);
  });

  it('loads an object-shaped { address: source } JSON file', async () => {
    const filePath = writeTempJson({ GCUSTOMADDRESS: 'custom-source' });
    const provider = await MockSanctionsProvider.fromFile({ flaggedAddresses: filePath });

    const flagged = await provider.checkAddress('GCUSTOMADDRESS');
    expect(flagged).toEqual({ flagged: true, source: 'custom-source' });

    const unflagged = await provider.checkAddress(KNOWN_UNFLAGGED_ADDRESS);
    expect(unflagged.flagged).toBe(false);
  });

  it('loads an array-shaped JSON file, defaulting every entry to the mock source', async () => {
    const filePath = writeTempJson(['GARRAYADDRESSONE', 'GARRAYADDRESSTWO']);
    const provider = await MockSanctionsProvider.fromFile({ flaggedAddresses: filePath });

    const result = await provider.checkAddress('GARRAYADDRESSONE');
    expect(result).toEqual({ flagged: true, source: 'mock-watchlist-v1' });
  });

  it('rejects when the file does not exist', async () => {
    await expect(
      MockSanctionsProvider.fromFile({ flaggedAddresses: '/nonexistent/path.json' }),
    ).rejects.toThrow('Failed to load flagged addresses from file /nonexistent/path.json');
  });

  it('rejects when the file contains invalid JSON', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-provider-test-'));
    const filePath = path.join(dir, 'addresses.json');
    fs.writeFileSync(filePath, 'not valid json');

    await expect(
      MockSanctionsProvider.fromFile({ flaggedAddresses: filePath }),
    ).rejects.toThrow(`Failed to load flagged addresses from file ${filePath}`);
  });

  it('accepts a directly-passed object without touching the filesystem', async () => {
    const provider = await MockSanctionsProvider.fromFile({
      flaggedAddresses: { GDIRECTADDRESS: 'direct-source' },
    });
    const result = await provider.checkAddress('GDIRECTADDRESS');
    expect(result).toEqual({ flagged: true, source: 'direct-source' });
  });
});
