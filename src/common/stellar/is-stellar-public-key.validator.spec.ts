import { validate } from 'class-validator';
import { IsStellarPublicKey } from './is-stellar-public-key.validator';

class Fixture {
  @IsStellarPublicKey()
  publicKey: string;
}

const VALID_KEY =
  'GBUQWP3BOUZX34ZONKXRBTLNNDOWR5HLCVPL2B4XNCLJTLMUMLTSOGBM';

describe('IsStellarPublicKey', () => {
  it('passes for a valid Stellar public key (checksum-correct)', async () => {
    const fixture = new Fixture();
    fixture.publicKey = VALID_KEY;

    const errors = await validate(fixture);

    expect(errors).toHaveLength(0);
  });

  it('fails for a checksum-corrupted key that still matches the shape regex', async () => {
    const fixture = new Fixture();
    // Flip the last character — same length/prefix, invalid checksum.
    fixture.publicKey = VALID_KEY.slice(0, -1) + (VALID_KEY.endsWith('A') ? 'B' : 'A');

    const errors = await validate(fixture);

    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toEqual(
      expect.objectContaining({
        isStellarPublicKey: expect.stringContaining('publicKey'),
      }),
    );
  });

  it('fails for a secret seed (S...) passed where a public key is expected', async () => {
    const fixture = new Fixture();
    fixture.publicKey = 'SBUQWP3BOUZX34ZONKXRBTLNNDOWR5HLCVPL2B4XNCLJTLMUMLTSOGBM';

    const errors = await validate(fixture);

    expect(errors).toHaveLength(1);
  });

  it('fails for non-string input', async () => {
    const fixture = new Fixture();
    (fixture as unknown as { publicKey: unknown }).publicKey = 12345;

    const errors = await validate(fixture);

    expect(errors).toHaveLength(1);
  });

  it('fails for an empty string', async () => {
    const fixture = new Fixture();
    fixture.publicKey = '';

    const errors = await validate(fixture);

    expect(errors).toHaveLength(1);
  });
});
