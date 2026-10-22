/// <reference types="jest" />
/**
 * Property-based / fuzz tests for CsvSanctionsProvider's CSV loader.
 *
 * Mirrors sep10-auth/test/verify.fuzz.test.ts, which fuzzes SEP-10 challenge
 * XDR parsing. CsvSanctionsProvider.loadCsv() parses arbitrary user-supplied
 * file content with a hand-rolled RFC 4180-aware parser, so it must be
 * hardened against every kind of malformed input:
 *
 *   - it must NEVER throw an unhandled exception (the constructor calls
 *     loadCsv synchronously) and must NEVER crash the process;
 *   - checkAddress() must always return a structurally valid result;
 *   - the internal flagged-address map must only ever contain valid Stellar
 *     ed25519 public keys — never a garbage "address" scraped from a
 *     misparsed row.
 *
 * Known tricky inputs the naive `.split(',')` parser could not handle and
 * that these tests exercise concretely: embedded commas in quoted fields,
 * escaped quotes, CRLF line endings, a leading UTF-8 BOM, unterminated
 * quotes, NUL bytes, and very large inputs.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as fc from 'fast-check';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { CsvSanctionsProvider } from '../src/csvProvider';

const KNOWN_UNFLAGGED_ADDRESS = Keypair.random().publicKey();

let tmpDir: string;
let csvPath: string;
let warnSpy: jest.SpyInstance;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-provider-fuzz-'));
  csvPath = path.join(tmpDir, 'addresses.csv');
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  // The loader is expected to be noisy on malformed input; silence it so the
  // fuzz output stays readable, but keep the spy so we can assert on it.
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
});

/** Write `content` to the shared temp CSV path and construct a provider. */
function loadProvider(content: string | Buffer): CsvSanctionsProvider {
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(csvPath, content);
  return new CsvSanctionsProvider(csvPath);
}

/** The internal flagged-address map — read for invariant checks only. */
function flaggedMap(provider: CsvSanctionsProvider): Map<string, string[]> {
  return (provider as unknown as { flaggedAddresses: Map<string, string[]> }).flaggedAddresses;
}

/**
 * Assert every core invariant that must hold no matter what bytes were fed
 * to the loader.
 */
async function assertInvariants(provider: CsvSanctionsProvider): Promise<void> {
  // 1. The map only ever holds valid Stellar addresses with a non-empty
  //    list of string sources.
  for (const [address, sources] of flaggedMap(provider)) {
    expect(StrKey.isValidEd25519PublicKey(address)).toBe(true);
    expect(Array.isArray(sources)).toBe(true);
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(typeof source).toBe('string');
      expect(source.length).toBeGreaterThan(0);
    }
  }

  // 2. checkAddress always returns a structurally valid result and never
  //    throws.
  const result = await provider.checkAddress(KNOWN_UNFLAGGED_ADDRESS);
  expect(typeof result).toBe('object');
  expect(typeof result.flagged).toBe('boolean');
  expect(typeof result.source).toBe('string');
  expect(result.flagged).toBe(false);
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** A single CSV field's raw (pre-quoting) text. */
const rawField = fc.oneof(
  fc.string({ maxLength: 40 }),
  fc.stringMatching(/^[ -~]{0,20}$/), // printable ASCII, includes , and "
  fc.constantFrom('', ',', '""', '"', 'OFAC, SDN List', 'a"b', '\n', '\r\n', '\r'),
);

/** Wrap a raw field in RFC 4180 quotes (escaping embedded quotes). */
function quote(raw: string): string {
  return '"' + raw.replace(/"/g, '""') + '"';
}

/** A field as it would appear serialized in a CSV line. */
const serializedField = fc
  .tuple(rawField, fc.boolean())
  .map(([raw, quoted]) => (quoted ? quote(raw) : raw));

const lineEnding = fc.constantFrom('\n', '\r\n', '\r');

/** A whole CSV document assembled from random rows. */
const csvDocument = fc
  .array(fc.array(serializedField, { minLength: 0, maxLength: 4 }), {
    minLength: 0,
    maxLength: 30,
  })
  .chain((rows) =>
    fc
      .array(lineEnding, { minLength: rows.length, maxLength: rows.length })
      .map((endings) => rows.map((cols, i) => cols.join(',') + endings[i]).join('')),
  );

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe('CsvSanctionsProvider – property-based / fuzz tests', () => {
  it('P1: never throws for arbitrary unicode file content', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (content) => {
        const provider = loadProvider(content);
        await assertInvariants(provider);
      }),
      { numRuns: 400, seed: 0xcafe },
    );
  });

  it('P2: never throws for arbitrary raw bytes written as the file', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 0, maxLength: 4096 }), async (bytes) => {
        const provider = loadProvider(Buffer.from(bytes));
        await assertInvariants(provider);
      }),
      { numRuns: 300, seed: 0xdead },
    );
  });

  it('P3: never throws for structured-but-hostile CSV documents', async () => {
    await fc.assert(
      fc.asyncProperty(csvDocument, async (content) => {
        const provider = loadProvider(content);
        await assertInvariants(provider);
      }),
      { numRuns: 400, seed: 0xbeef },
    );
  });

  it('P4: real addresses buried in garbage rows are still flagged, garbage never is', async () => {
    const realAddresses = fc.array(
      fc.constant(null).map(() => Keypair.random().publicKey()),
      { minLength: 1, maxLength: 5 },
    );

    await fc.assert(
      fc.asyncProperty(
        realAddresses,
        csvDocument,
        fc.stringMatching(/^[ -~]{0,20}$/),
        async (addresses, noise, source) => {
          const cleanSource = source.replace(/[\r\n,"]/g, '').trim() || 'fuzz-source';
          const goodRows = addresses.map((a) => `${a},${cleanSource}`).join('\n');
          const content = `address,source\n${goodRows}\n${noise}`;
          const provider = loadProvider(content);

          await assertInvariants(provider);

          for (const address of addresses) {
            const res = await provider.checkAddress(address);
            expect(res.flagged).toBe(true);
            expect(res.source).toContain(cleanSource);
          }
        },
      ),
      { numRuns: 200, seed: 0xf00d },
    );
  });

  it('P5: fixed edge-case documents never throw', async () => {
    const validAddress = Keypair.random().publicKey();
    const edgeCases = [
      '',
      ' ',
      '\n',
      '\r\n',
      '\r',
      '\0',
      '\0'.repeat(256),
      '﻿',
      '﻿address,source\n',
      'address,source', // header only, no trailing newline
      'address,source\n"unterminated,quoted,field',
      `address,source\n${validAddress},"multi\nline\nsource"\n`,
      `address,source\r\n${validAddress},"OFAC, SDN List"\r\n`,
      `address,source\n${validAddress},"he said ""hi"""\n`,
      `address,source\n,,,,,\n${validAddress}\n`,
      `${validAddress},only-one-row-no-header`,
      'address,source\n' + 'A,B\n'.repeat(5000),
      'address,source\n' + `${validAddress},s\n`.repeat(2000),
      '你好,世界\n🚀,🌕\n',
    ];

    for (const content of edgeCases) {
      const provider = loadProvider(content);
      // eslint-disable-next-line no-await-in-loop
      await assertInvariants(provider);
    }
  });

  it('P6: quoted fields with embedded commas/quotes round-trip as a single source', async () => {
    const validAddress = Keypair.random().publicKey();
    await fc.assert(
      fc.asyncProperty(
        // Printable ASCII (includes commas and quotes) that survives a
        // UTF-8 file round-trip, with at least one non-whitespace char.
        fc.stringMatching(/^[ -~]{1,30}$/).filter((s) => s.trim().length > 0),
        async (rawSource) => {
          const content = `address,source\n${validAddress},${quote(rawSource)}\n`;
          const provider = loadProvider(content);
          const res = await provider.checkAddress(validAddress);
          expect(res.flagged).toBe(true);
          // The single quoted field must be preserved verbatim (trimmed),
          // not split on any comma it happens to contain.
          expect(res.source).toBe(rawSource.trim());
        },
      ),
      { numRuns: 200, seed: 0xceed },
    );
  });
});
