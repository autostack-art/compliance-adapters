import { SanctionsProvider } from '../src/SanctionsProvider';

/**
 * Reusable test suite that asserts any SanctionsProvider implementation
 * conforms to the contract: checkAddress always resolves with a boolean
 * `flagged` and non-empty `source`.
 *
 * Usage:
 *   describe('MyCustomProvider', () => {
 *     it('conforms to SanctionsProvider', async () => {
 *       const provider = new MyCustomProvider();
 *       await assertSanctionsProviderContract(provider);
 *     });
 *   });
 */
export async function assertSanctionsProviderContract(
  provider: SanctionsProvider,
  testAddress: string = 'GDNOTPRESENTINANYMOCKWATCHLISTAAAAAAAAAAAAAAAAAAAAAAAAAA',
): Promise<void> {
  const result = await provider.checkAddress(testAddress);

  expect(typeof result.flagged).toBe('boolean');
  expect(typeof result.source).toBe('string');
  expect(result.source.length).toBeGreaterThan(0);
}
