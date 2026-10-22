import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CsvSanctionsProvider } from '../src/csvProvider';

const KNOWN_UNFLAGGED_ADDRESS = 'GDNOTPRESENTINANYMOCKWATCHLISTAAAAAAAAAAAAAAAAAAAAAAAAAA';

/** Writes `content` to a fresh temp file and returns its path. */
function writeTempCsv(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-provider-test-'));
  const filePath = path.join(dir, 'addresses.csv');
  fs.writeFileSync(filePath, content);
  return filePath;
}

describe('CsvSanctionsProvider', () => {
  const fixturesCsvPath = path.join(__dirname, 'fixtures', 'addresses.csv');

  describe('happy path', () => {
    it('flags a known CSV watchlist address', async () => {
      const provider = new CsvSanctionsProvider(fixturesCsvPath);
      const result = await provider.checkAddress(
        'GD7PQQDZ75ZIY3O3CZKO4P6NBRBDBYEM6PKROQUVKMXI6J2SAB4FWYAN',
      );
      expect(result.flagged).toBe(true);
      expect(result.source).toBe('csv-watchlist-v1');
    });

    it('does not flag an address absent from the CSV watchlist', async () => {
      const provider = new CsvSanctionsProvider(fixturesCsvPath);
      const result = await provider.checkAddress(KNOWN_UNFLAGGED_ADDRESS);
      expect(result.flagged).toBe(false);
      expect(result.source).toBe('csv-watchlist-v1');
    });

    it('defaults the source column to csv-watchlist-v1 when a row omits it', async () => {
      const csvPath = writeTempCsv(
        'address,source\n' + 'GCSZ2L4YY3JHAT5ADE2DWP75QOWMKPHCWDO6FG7B6SSZOYNFXXMQHL66\n',
      );
      const provider = new CsvSanctionsProvider(csvPath);
      const result = await provider.checkAddress(
        'GCSZ2L4YY3JHAT5ADE2DWP75QOWMKPHCWDO6FG7B6SSZOYNFXXMQHL66',
      );
      expect(result.flagged).toBe(true);
      expect(result.source).toBe('csv-watchlist-v1');
    });

    it('uses an explicit source column value when present', async () => {
      const csvPath = writeTempCsv(
        'address,source\n' +
          'GCSZ2L4YY3JHAT5ADE2DWP75QOWMKPHCWDO6FG7B6SSZOYNFXXMQHL66,custom-source\n',
      );
      const provider = new CsvSanctionsProvider(csvPath);
      const result = await provider.checkAddress(
        'GCSZ2L4YY3JHAT5ADE2DWP75QOWMKPHCWDO6FG7B6SSZOYNFXXMQHL66',
      );
      expect(result.flagged).toBe(true);
      expect(result.source).toBe('custom-source');
    });
  });

  describe('missing file', () => {
    it('warns and treats every address as unflagged instead of throwing', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const provider = new CsvSanctionsProvider('/nonexistent/path.csv');

        const result = await provider.checkAddress(KNOWN_UNFLAGGED_ADDRESS);
        expect(result.flagged).toBe(false);
        expect(result.source).toBe('csv-watchlist-v1');

        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('CSV file not found at path: /nonexistent/path.csv'),
        );
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe('malformed rows', () => {
    it('skips a row whose address column is not a valid Stellar G... address, without stopping the load', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const provider = new CsvSanctionsProvider(fixturesCsvPath);

        const invalidResult = await provider.checkAddress('NOT-A-VALID-STELLAR-ADDRESS');
        expect(invalidResult.flagged).toBe(false);

        const validResult = await provider.checkAddress(
          'GCSNJ6SE42RKXVFLWHFWRZKAWOVSTVVTZ2HBM2JV45NY3GGMB6PJBMXX',
        );
        expect(validResult.flagged).toBe(true);

        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('NOT-A-VALID-STELLAR-ADDRESS'),
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('ignores blank lines between rows', async () => {
      const csvPath = writeTempCsv(
        'address,source\n' +
          '\n' +
          'GCSZ2L4YY3JHAT5ADE2DWP75QOWMKPHCWDO6FG7B6SSZOYNFXXMQHL66,csv-watchlist-v1\n' +
          '\n',
      );
      const provider = new CsvSanctionsProvider(csvPath);
      const result = await provider.checkAddress(
        'GCSZ2L4YY3JHAT5ADE2DWP75QOWMKPHCWDO6FG7B6SSZOYNFXXMQHL66',
      );
      expect(result.flagged).toBe(true);
    });

    it('trims whitespace around address and source columns', async () => {
      const csvPath = writeTempCsv(
        'address,source\n' +
          '  GCSZ2L4YY3JHAT5ADE2DWP75QOWMKPHCWDO6FG7B6SSZOYNFXXMQHL66  ,  padded-source  \n',
      );
      const provider = new CsvSanctionsProvider(csvPath);
      const result = await provider.checkAddress(
        'GCSZ2L4YY3JHAT5ADE2DWP75QOWMKPHCWDO6FG7B6SSZOYNFXXMQHL66',
      );
      expect(result.flagged).toBe(true);
      expect(result.source).toBe('padded-source');
    });

    it('aggregates distinct sources when the same address appears in multiple rows', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const csvPath = writeTempCsv(
          'address,source\n' +
            'GCSZ2L4YY3JHAT5ADE2DWP75QOWMKPHCWDO6FG7B6SSZOYNFXXMQHL66,first-source\n' +
            'GCSZ2L4YY3JHAT5ADE2DWP75QOWMKPHCWDO6FG7B6SSZOYNFXXMQHL66,second-source\n',
        );
        const provider = new CsvSanctionsProvider(csvPath);
        const result = await provider.checkAddress(
          'GCSZ2L4YY3JHAT5ADE2DWP75QOWMKPHCWDO6FG7B6SSZOYNFXXMQHL66',
        );
        expect(result.flagged).toBe(true);
        expect(result.source).toBe('first-source,second-source');
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('appears more than once'));
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('warns but does not duplicate when the same address+source pair repeats', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const csvPath = writeTempCsv(
          'address,source\n' +
            'GCSZ2L4YY3JHAT5ADE2DWP75QOWMKPHCWDO6FG7B6SSZOYNFXXMQHL66,dup-source\n' +
            'GCSZ2L4YY3JHAT5ADE2DWP75QOWMKPHCWDO6FG7B6SSZOYNFXXMQHL66,dup-source\n',
        );
        const provider = new CsvSanctionsProvider(csvPath);
        const result = await provider.checkAddress(
          'GCSZ2L4YY3JHAT5ADE2DWP75QOWMKPHCWDO6FG7B6SSZOYNFXXMQHL66',
        );
        expect(result.flagged).toBe(true);
        expect(result.source).toBe('dup-source');
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('the duplicate row was ignored'),
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('parses RFC 4180 quoted source fields that contain commas', async () => {
      const csvPath = writeTempCsv(
        'address,source\n' +
          'GCSZ2L4YY3JHAT5ADE2DWP75QOWMKPHCWDO6FG7B6SSZOYNFXXMQHL66,"OFAC, SDN List"\n',
      );
      const provider = new CsvSanctionsProvider(csvPath);
      const result = await provider.checkAddress(
        'GCSZ2L4YY3JHAT5ADE2DWP75QOWMKPHCWDO6FG7B6SSZOYNFXXMQHL66',
      );
      expect(result.flagged).toBe(true);
      expect(result.source).toBe('OFAC, SDN List');
    });

    it('handles a quoted address column and CRLF line endings', async () => {
      const csvPath = writeTempCsv(
        'address,source\r\n' +
          '"GCSZ2L4YY3JHAT5ADE2DWP75QOWMKPHCWDO6FG7B6SSZOYNFXXMQHL66","list-a"\r\n',
      );
      const provider = new CsvSanctionsProvider(csvPath);
      const result = await provider.checkAddress(
        'GCSZ2L4YY3JHAT5ADE2DWP75QOWMKPHCWDO6FG7B6SSZOYNFXXMQHL66',
      );
      expect(result.flagged).toBe(true);
      expect(result.source).toBe('list-a');
    });

    it('ignores a leading UTF-8 BOM on the header row', async () => {
      const csvPath = writeTempCsv(
        '﻿address,source\n' +
          'GCSZ2L4YY3JHAT5ADE2DWP75QOWMKPHCWDO6FG7B6SSZOYNFXXMQHL66,bom-source\n',
      );
      const provider = new CsvSanctionsProvider(csvPath);
      const result = await provider.checkAddress(
        'GCSZ2L4YY3JHAT5ADE2DWP75QOWMKPHCWDO6FG7B6SSZOYNFXXMQHL66',
      );
      expect(result.flagged).toBe(true);
      expect(result.source).toBe('bom-source');
    });
  });

  describe('header-only file', () => {
    it('loads zero addresses and treats everything as unflagged', async () => {
      const csvPath = writeTempCsv('address,source\n');
      const provider = new CsvSanctionsProvider(csvPath);
      const result = await provider.checkAddress(KNOWN_UNFLAGGED_ADDRESS);
      expect(result.flagged).toBe(false);
      expect(result.source).toBe('csv-watchlist-v1');
    });
  });

  describe('injectable logger', () => {
    it('routes load warnings to a supplied logger instead of console', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
      try {
        new CsvSanctionsProvider('/nonexistent/path.csv', { logger });

        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining('CSV file not found at path: /nonexistent/path.csv'),
        );
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });
  });
});
