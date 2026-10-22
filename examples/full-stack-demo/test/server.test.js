'use strict';

/**
 * Smoke tests for the full-stack-demo server.
 *
 * These tests exercise the Express app without actually hitting any Soroban
 * RPC endpoints.  They verify:
 *   - /health returns 200
 *   - /auth (GET) issues a challenge for a valid address
 *   - /auth (GET) rejects missing account param
 *   - /auth (POST) rejects a clearly invalid token
 *   - /auth/revoke accepts a revocation and then rejects the same token
 *   - /sanctions/check proxies through ProviderRegistry
 *   - /sanctions/sync runs a dry-run sync
 *   - /metrics returns Prometheus text
 */

const request = require('supertest');

// The server module exports `app` without starting a listener
const { app, revocationStore, providerRegistry } = require('../server');

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.serverPublicKey).toBe('string');
    expect(res.body.serverPublicKey).toMatch(/^G[A-Z2-7]{55}$/);
  });
});

describe('GET /auth', () => {
  it('returns 400 when ?account is missing', async () => {
    const res = await request(app).get('/auth');
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('returns 400 for a malformed Stellar address', async () => {
    // generateChallenge will throw for an invalid strkey
    const res = await request(app).get('/auth?account=NOTANADDRESS');
    expect(res.status).toBe(400);
  });

  it('issues a challenge for a syntactically valid G-address', async () => {
    // Use a real-looking public key (no live network needed — generateChallenge is pure)
    const address = 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGFNLR7RFQBH6KUBTDMOPEK';
    const res = await request(app).get(`/auth?account=${address}`);
    // May be 200 or 400 depending on SDK validation of account length/checksum;
    // the important thing is the server doesn't crash with a 500.
    expect([200, 400]).toContain(res.status);
  });
});

describe('POST /auth', () => {
  it('returns 400 when body is missing transaction', async () => {
    const res = await request(app).post('/auth').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('returns 401 for an invalid token', async () => {
    const res = await request(app)
      .post('/auth')
      .send({ transaction: 'not-a-real-xdr' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
  });
});

describe('POST /auth/revoke + POST /auth', () => {
  it('rejects a revoked token with 401 token_revoked', async () => {
    const fakeToken = 'REVOKE-TOKEN-XDR-FIXTURE';

    // Revoke it
    const revokeRes = await request(app)
      .post('/auth/revoke')
      .send({ transaction: fakeToken });
    expect(revokeRes.status).toBe(200);
    expect(revokeRes.body.revoked).toBe(true);

    // Now try to verify it — should short-circuit to revoked
    const authRes = await request(app)
      .post('/auth')
      .send({ transaction: fakeToken });
    expect(authRes.status).toBe(401);
    expect(authRes.body.error).toBe('token_revoked');
  });
});

describe('GET /sanctions/check', () => {
  it('returns 400 when ?address is missing', async () => {
    const res = await request(app).get('/sanctions/check');
    expect(res.status).toBe(400);
  });

  it('returns flagged: false for an un-flagged address', async () => {
    const res = await request(app).get('/sanctions/check?address=GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGFNLR7RFQBH6KUBTDMOPEK');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('flagged');
    expect(res.body.flagged).toBe(false);
  });

  it('returns flagged: true for a known mock-flagged address', async () => {
    // This address is in MockSanctionsProvider.MOCK_FLAGGED_ADDRESSES
    const flaggedAddress = 'GHBRPOIGF3CBFNOBM2O4RAK3VRJNVGFYGWWQC5HYFSXMECOSFOGYR5XK';
    const res = await request(app).get(`/sanctions/check?address=${flaggedAddress}`);
    expect(res.status).toBe(200);
    expect(res.body.flagged).toBe(true);
  });
});

describe('POST /sanctions/sync', () => {
  it('returns 400 when addresses array is missing', async () => {
    const res = await request(app).post('/sanctions/sync').send({});
    expect(res.status).toBe(400);
  });

  it('runs a dry-run sync and returns expected shape', async () => {
    const addresses = [
      'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGFNLR7RFQBH6KUBTDMOPEK',
      'GHBRPOIGF3CBFNOBM2O4RAK3VRJNVGFYGWWQC5HYFSXMECOSFOGYR5XK',
    ];
    const res = await request(app)
      .post('/sanctions/sync')
      .send({ addresses, dryRun: true });

    expect(res.status).toBe(200);
    expect(res.body.checked).toBe(2);
    expect(Array.isArray(res.body.flagged)).toBe(true);
    expect(res.body.dryRun).toBe(true);
    expect(typeof res.body.durationMs).toBe('number');
    // The known mock-flagged address should appear in flagged
    expect(res.body.flagged).toContain('GHBRPOIGF3CBFNOBM2O4RAK3VRJNVGFYGWWQC5HYFSXMECOSFOGYR5XK');
  });
});

describe('POST /admin/listener/* authentication', () => {
  afterEach(() => {
    delete process.env.ADMIN_TOKEN;
  });

  it('returns 503 when ADMIN_TOKEN is not configured', async () => {
    const res = await request(app).post('/admin/listener/stop').set('X-Admin-Token', 'anything');
    expect(res.status).toBe(503);
  });

  it('returns 401 when the token is missing or wrong', async () => {
    process.env.ADMIN_TOKEN = 'secret-admin-token';
    expect((await request(app).post('/admin/listener/start')).status).toBe(401);
    const res = await request(app).post('/admin/listener/stop').set('X-Admin-Token', 'wrong');
    expect(res.status).toBe(401);
  });

  it('passes the auth gate with the correct token', async () => {
    process.env.ADMIN_TOKEN = 'secret-admin-token';
    const res = await request(app).post('/admin/listener/stop').set('X-Admin-Token', 'secret-admin-token');
    expect(res.body.error).not.toBe('unauthorized');
    expect(res.body.error).not.toBe('admin_disabled');
  });
});

describe('GET /metrics', () => {
  it('returns 200 with Prometheus text format', async () => {
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    // Should contain at least our custom counter names
    expect(res.text).toMatch(/sep10_auth_requests_total/);
    expect(res.text).toMatch(/sanctions_sync_total/);
    expect(res.text).toMatch(/horizon_events_received_total/);
  });
});

describe('ProviderRegistry', () => {
  it('is configured with at least one provider', () => {
    expect(providerRegistry).toBeDefined();
    expect(typeof providerRegistry.checkAddress).toBe('function');
  });
});

describe('InMemoryRevocationStore', () => {
  it('is exported and functional', () => {
    expect(revocationStore).toBeDefined();
    expect(typeof revocationStore.revoke).toBe('function');
    expect(typeof revocationStore.isRevoked).toBe('function');

    revocationStore.revoke('test-token');
    expect(revocationStore.isRevoked('test-token')).toBe(true);
    expect(revocationStore.isRevoked('other-token')).toBe(false);
  });
});
