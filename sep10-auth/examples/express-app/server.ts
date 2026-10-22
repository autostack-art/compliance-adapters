import { Keypair } from '@stellar/stellar-sdk';
import { createApp } from './app';

// Demo-only server keypair. A real deployment loads this from a secret store
// (e.g. process.env.SEP10_SERVER_SECRET) and keeps it stable across restarts,
// since the public key is the server account clients authenticate against.
const serverKeypair = process.env.SEP10_SERVER_SECRET
  ? Keypair.fromSecret(process.env.SEP10_SERVER_SECRET)
  : Keypair.random();

const { app } = createApp({
  serverKeypair,
  homeDomain: 'example.com',
  webAuthDomain: 'example.com',
});

const PORT = process.env.PORT ?? 3000;

app.listen(PORT, () => {
  console.log(`SEP-10 example app listening on http://localhost:${PORT}`);
  console.log(`Server account: ${serverKeypair.publicKey()}`);
});
