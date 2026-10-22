/// <reference types="jest" />

/**
 * Integration tests for the SEP-10 + sanctions-gate composed route.
 *
 * Strategy: the SEP-10 middleware calls verifyChallenge internally, which in
 * turn calls the Stellar SDK's WebAuth utilities — those would require a live
 * network to produce valid signed XDR.  We mock the entire `sep10-auth` module
 * so that:
 *   - requests with `Authorization: Bearer valid-token-<address>` are treated
 *     as authenticated with that address, and
 *   - any other (or missing) Authorization header results in a 401.
 *
 * The sanctions check is exercised with the real MockSanctionsProvider from
 * sanctions-oracle, which flags a fixed set of known addresses (imported as
 * MOCK_FLAGGED_ADDRESSES).  This gives us genuine end-to-end coverage of the
 * composed middleware chain without a live Stellar network dependency.
 */

import request from 'supertest';
import { MOCK_FLAGGED_ADDRESSES } from 'sanctions-oracle';
import { createApp } from '../src/app';

// ── Mock sep10-auth ───────────────────────────────────────────────────────────
// Replace createSep10Middleware with a lightweight stub so tests don't need a
// real signed SEP-10 challenge XDR (which would require a live network or
// intricate transaction construction).
//
// Convention used by this stub:
//   Authorization: Bearer valid-token-<stellarAddress>  → sets req.stellarAddress, calls next()
//   anything else (missing, wrong scheme, etc.)         → 401
jest.mock('sep10-auth', () => {
  const VALID_PREFIX = 'valid-token-';

  return {
    createSep10Middleware: () => {
      // Return a standard Express RequestHandler.
      return (req: any, res: any, next: any) => {
        const authHeader: string = req.headers?.authorization ?? '';
        const [scheme, token] = authHeader.split(' ');

        if (scheme !== 'Bearer' || !token || !token.startsWith(VALID_PREFIX)) {
          res.status(401).json({ error: 'unauthorized', reason: 'missing or invalid bearer token' });
          return;
        }

        // Extract the address encoded after the prefix.
        req.stellarAddress = token.slice(VALID_PREFIX.length);
        next();
      };
    },
  };
});

// ── Shared app instance ───────────────────────────────────────────────────────
// A single app shared across all tests; the stub options are irrelevant because
// createSep10Middleware is mocked above, but the shape must still be valid.
const app = createApp({
  sep10: {
    serverAccountId: 'GPLACEHOLDER000000000000000000000000000000000000000000',
    homeDomains: 'localhost:3000',
    webAuthDomain: 'localhost:3000',
  },
  // No sanctionsProvider → defaults to MockSanctionsProvider inside createApp.
});

// A known-clean address (not in MOCK_FLAGGED_ADDRESSES).
const CLEAN_ADDRESS = 'GACLEANADDRESS00000000000000000000000000000000000000';

// Pick the first known-flagged address from the mock provider's list.
const FLAGGED_ADDRESS = Object.keys(MOCK_FLAGGED_ADDRESSES)[0];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns 200 with { status: ok } without any authentication', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});

describe('GET /gated', () => {
  // ── 401: no auth header ────────────────────────────────────────────────────
  it('returns 401 when no Authorization header is provided', async () => {
    const res = await request(app).get('/gated');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
  });

  // ── 401: wrong scheme ─────────────────────────────────────────────────────
  it('returns 401 when Authorization uses a non-Bearer scheme', async () => {
    const res = await request(app)
      .get('/gated')
      .set('Authorization', `Basic sometoken`);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
  });

  // ── 401: Bearer present but token is not a valid stub token ───────────────
  it('returns 401 when the Bearer token is invalid', async () => {
    const res = await request(app)
      .get('/gated')
      .set('Authorization', 'Bearer not-a-valid-token');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
  });

  // ── 403: authenticated but sanctioned address ─────────────────────────────
  it('returns 403 when the authenticated address is on the sanctions watchlist', async () => {
    const res = await request(app)
      .get('/gated')
      .set('Authorization', `Bearer valid-token-${FLAGGED_ADDRESS}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
    expect(res.body.reason).toMatch(/sanctions/i);
  });

  // ── 200: authenticated and clean ──────────────────────────────────────────
  it('returns 200 when the authenticated address is not on any watchlist', async () => {
    const res = await request(app)
      .get('/gated')
      .set('Authorization', `Bearer valid-token-${CLEAN_ADDRESS}`);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Access granted');
    expect(res.body.address).toBe(CLEAN_ADDRESS);
  });

  // ── 200 response shape ────────────────────────────────────────────────────
  it('returns the verified address in the 200 response body', async () => {
    const address = 'GANOTHERCLEANADDRESS0000000000000000000000000000000000';

    const res = await request(app)
      .get('/gated')
      .set('Authorization', `Bearer valid-token-${address}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ message: 'Access granted', address });
  });

  // ── All known flagged addresses are blocked ───────────────────────────────
  it('returns 403 for every address in MOCK_FLAGGED_ADDRESSES', async () => {
    for (const flaggedAddress of Object.keys(MOCK_FLAGGED_ADDRESSES)) {
      const res = await request(app)
        .get('/gated')
        .set('Authorization', `Bearer valid-token-${flaggedAddress}`);

      expect(res.status).toBe(403);
    }
  });
});
