/**
 * Copyright (c) 2026 stellar-compliance-kit
 * SPDX-License-Identifier: MIT
 */

/**
 * Entry point — instantiates the gated Express app and starts listening.
 *
 * Configuration is read from environment variables so the same binary works
 * in local dev (with sensible defaults) and in a real deployment:
 *
 *   PORT                  TCP port to listen on            (default: 3000)
 *   SERVER_ACCOUNT_ID     SEP-10 server's G... public key  (required)
 *   HOME_DOMAIN           SEP-10 home domain               (required)
 *   WEB_AUTH_DOMAIN       SEP-10 web-auth domain           (default: HOME_DOMAIN)
 *   NETWORK_PASSPHRASE    Stellar network passphrase        (default: testnet)
 *
 * For local development you can create a `.env` file and load it with a tool
 * like `dotenv-cli`:
 *
 *   npx dotenv-cli -- node dist/server.js
 *
 * In production, set the env vars through your deployment platform (ECS task
 * definition, Kubernetes Secret, etc.).
 */

import { Networks } from '@stellar/stellar-sdk';
import { createApp } from './app';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const SERVER_ACCOUNT_ID = process.env.SERVER_ACCOUNT_ID ?? '';
const HOME_DOMAIN = process.env.HOME_DOMAIN ?? 'localhost:3000';
const WEB_AUTH_DOMAIN = process.env.WEB_AUTH_DOMAIN ?? HOME_DOMAIN;
const NETWORK_PASSPHRASE = process.env.NETWORK_PASSPHRASE ?? Networks.TESTNET;

if (!SERVER_ACCOUNT_ID) {
  console.error('[sep10-sanctions-gate] SERVER_ACCOUNT_ID env var is required');
  process.exit(1);
}

const app = createApp({
  sep10: {
    serverAccountId: SERVER_ACCOUNT_ID,
    networkPassphrase: NETWORK_PASSPHRASE,
    homeDomains: HOME_DOMAIN,
    webAuthDomain: WEB_AUTH_DOMAIN,
  },
  // No sanctionsProvider supplied → createApp defaults to MockSanctionsProvider.
  // Replace with a real licensed provider before deploying to production.
});

app.listen(PORT, () => {
  console.log(`[sep10-sanctions-gate] listening on port ${PORT}`);
  console.log(`  server account : ${SERVER_ACCOUNT_ID}`);
  console.log(`  home domain    : ${HOME_DOMAIN}`);
  console.log(`  network        : ${NETWORK_PASSPHRASE}`);
  console.log(`  GET /gated     — SEP-10 auth + sanctions check`);
});
