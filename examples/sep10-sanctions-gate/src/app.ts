/**
 * Copyright (c) 2026 stellar-compliance-kit
 * SPDX-License-Identifier: MIT
 */

/**
 * sep10-sanctions-gate — example Express app
 *
 * Demonstrates composing two compliance-adapters packages on a single route:
 *
 *   1. SEP-10 authentication (sep10-auth)
 *      The request must carry a valid SEP-10 challenge response as a Bearer
 *      token.  createSep10Middleware verifies the signed XDR and, on success,
 *      attaches the verified Stellar address to `req.stellarAddress`.
 *      → unauthenticated or invalid token: 401
 *
 *   2. Sanctions check (sanctions-oracle)
 *      The verified address is looked up against a SanctionsProvider.  The
 *      example wires in MockSanctionsProvider (development/test only — never
 *      use the mock in production; integrate a real licensed data source).
 *      → flagged address: 403
 *      → clean address: 200
 *
 * The two steps are intentionally separate middleware functions so either can
 * be swapped out without touching the other.
 */

import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import { createSep10Middleware, VerifyChallengeOptions } from 'sep10-auth';
import { SanctionsProvider, MockSanctionsProvider } from 'sanctions-oracle';

export interface GatedAppOptions {
  /** Options forwarded verbatim to createSep10Middleware / verifyChallenge. */
  sep10: VerifyChallengeOptions;
  /**
   * Sanctions provider to use.  Defaults to MockSanctionsProvider when omitted.
   * Swap this for a real provider before using in production.
   */
  sanctionsProvider?: SanctionsProvider;
}

/**
 * Build and return the Express application.
 *
 * Keeping app construction separate from server startup (listen) makes the
 * app trivially testable with supertest without binding to a port.
 */
export function createApp(options: GatedAppOptions): express.Application {
  const app = express();

  // Parse JSON request bodies so downstream handlers can read req.body if needed.
  app.use(express.json());

  // ── Step 1: SEP-10 authentication middleware ──────────────────────────────
  // Validates the `Authorization: Bearer <signed-challenge-XDR>` header and,
  // on success, sets `req.stellarAddress` to the verified Stellar G... address.
  // On failure it responds with 401 and short-circuits the chain — the
  // sanctions check below never runs.
  const sep10Middleware: RequestHandler = createSep10Middleware(options.sep10);

  // ── Step 2: Sanctions check middleware ───────────────────────────────────
  // Runs after SEP-10 has already validated identity, so `req.stellarAddress`
  // is guaranteed to be set here.  We keep this as a named factory so callers
  // can inject any SanctionsProvider implementation (real or mock).
  const provider: SanctionsProvider = options.sanctionsProvider ?? new MockSanctionsProvider();

  const sanctionsMiddleware: RequestHandler = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    // req.stellarAddress is set by sep10Middleware which runs first; the type
    // augmentation in sep10-auth declares it as `string | undefined` so we
    // guard with a non-null assertion — if we reached this point it is set.
    const address = req.stellarAddress!;

    const result = await provider.checkAddress(address);

    if (result.flagged) {
      // The address appears on a sanctions / watchlist.  Return 403 with
      // enough detail for the caller to know why they were blocked, but
      // without leaking which specific list flagged them.
      res.status(403).json({
        error: 'forbidden',
        reason: 'address is on a sanctions watchlist',
      });
      return;
    }

    // Address is clean — pass control to the route handler.
    next();
  };

  // ── Health-check route ───────────────────────────────────────────────────
  // Unauthenticated liveness probe for container orchestrators and load
  // balancer health checks.  Must be registered before the SEP-10 middleware
  // so it is never accidentally gated behind auth.
  app.get('/health', (_req: Request, res: Response): void => {
    res.status(200).json({ status: 'ok' });
  });

  // ── Gated route ──────────────────────────────────────────────────────────
  // Apply both middleware in order: auth first, sanctions second.
  // Only requests that clear both checks reach the handler.
  app.get(
    '/gated',
    sep10Middleware,
    sanctionsMiddleware,
    (_req: Request, res: Response): void => {
      res.status(200).json({
        message: 'Access granted',
        address: _req.stellarAddress,
      });
    },
  );

  return app;
}
