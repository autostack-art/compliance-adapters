import type { Request } from 'express';
// Importing the middleware module is what pulls the global Express.Request
// augmentation into the type-checked graph; ts-jest fails this file to compile
// if `stellarAddress` is ever lost or its type changes.
import '../src/middleware';

describe('Express.Request stellarAddress augmentation', () => {
  it('exposes an optional string `stellarAddress` on Express.Request', () => {
    const req = {} as Express.Request;
    const address: string | undefined = req.stellarAddress;
    req.stellarAddress = 'GABC';

    // @ts-expect-error stellarAddress must be typed as string, not number
    req.stellarAddress = 123;

    const expressReq = {} as Request;
    const fromExpressRequest: string | undefined = expressReq.stellarAddress;

    expect(address).toBeUndefined();
    expect(fromExpressRequest).toBeUndefined();
  });
});
