import {
  WebhookSignatureService,
  WebhookVerificationError,
} from './webhook-signature.service';
import {
  DEFAULT_SIGNATURE_TOLERANCE_SECONDS,
  MAX_SIGNATURE_HEADER_BYTES,
  MAX_SIGNATURE_TOLERANCE_SECONDS,
  WebhookVerifyErrorCode,
} from './webhook-signature.model';
import { MetricsService } from '../common/metrics/metrics.service';

const SECRET = 'whsec_super_secret_value';
const PAYLOAD = JSON.stringify({ id: 'evt_1', type: 'wallet.created' });
const NOW = 1_700_000_000;

function build() {
  const metrics = { incrementCounter: jest.fn() } as unknown as MetricsService;
  return {
    service: new WebhookSignatureService(metrics),
    metrics,
  };
}

/** Asserts that `run` rejects with the given stable code. */
async function expectCode(
  run: () => unknown,
  code: string,
): Promise<WebhookVerificationError> {
  try {
    await run();
  } catch (err) {
    expect(err).toBeInstanceOf(WebhookVerificationError);
    expect((err as WebhookVerificationError).code).toBe(code);
    return err as WebhookVerificationError;
  }
  throw new Error(`expected rejection with ${code}`);
}

describe('WebhookSignatureService', () => {
  let service: WebhookSignatureService;
  let metrics: { incrementCounter: jest.Mock };

  beforeEach(() => {
    ({ service, metrics } = build());
  });

  describe('happy path', () => {
    it('verifies a signature it produced', () => {
      const header = service.sign(SECRET, PAYLOAD, NOW);
      const parsed = service.verify({
        header,
        payload: PAYLOAD,
        secret: SECRET,
        nowSeconds: NOW,
      });

      expect(parsed.timestamp).toBe(NOW);
      expect(parsed.signature).toMatch(/^[0-9a-f]{64}$/);
      expect(metrics.incrementCounter).toHaveBeenCalledWith(
        'webhook_signature_verified',
      );
    });

    it('tolerates clock skew inside the default window', () => {
      const header = service.sign(SECRET, PAYLOAD, NOW);
      expect(() =>
        service.verify({
          header,
          payload: PAYLOAD,
          secret: SECRET,
          nowSeconds: NOW + DEFAULT_SIGNATURE_TOLERANCE_SECONDS,
        }),
      ).not.toThrow();
    });
  });

  describe('constant-time comparison', () => {
    it('rejects a single flipped hex nibble', () => {
      const header = service.sign(SECRET, PAYLOAD, NOW);
      const flipped = header.replace(
        /v1=(.)/,
        (_m, c: string) => `v1=${c === 'a' ? 'b' : 'a'}`,
      );

      expect(flipped).not.toBe(header);
      return expectCode(
        () =>
          service.verify({
            header: flipped,
            payload: PAYLOAD,
            secret: SECRET,
            nowSeconds: NOW,
          }),
        WebhookVerifyErrorCode.SIGNATURE_MISMATCH,
      );
    });

    it('never accepts a signature signed with a different secret', () => {
      const header = service.sign('other-secret', PAYLOAD, NOW);
      return expectCode(
        () =>
          service.verify({
            header,
            payload: PAYLOAD,
            secret: SECRET,
            nowSeconds: NOW,
          }),
        WebhookVerifyErrorCode.SIGNATURE_MISMATCH,
      );
    });

    it('rejects a signature replayed against a modified payload', () => {
      const header = service.sign(SECRET, PAYLOAD, NOW);
      return expectCode(
        () =>
          service.verify({
            header,
            payload: `${PAYLOAD} `,
            secret: SECRET,
            nowSeconds: NOW,
          }),
        WebhookVerifyErrorCode.SIGNATURE_MISMATCH,
      );
    });

    it('rejects a non-32-byte digest as malformed, not a crash', () => {
      // timingSafeEqual throws on a length mismatch; the parser must reject
      // the shape first so a short digest cannot become a 500.
      return expectCode(
        () =>
          service.verify({
            header: `t=${NOW},v1=${'a'.repeat(8)}`,
            payload: PAYLOAD,
            secret: SECRET,
            nowSeconds: NOW,
          }),
        WebhookVerifyErrorCode.MALFORMED_HEADER,
      );
    });
  });

  describe('fail closed', () => {
    it.each([undefined, null, '', '   '])(
      'refuses to verify without a configured secret (%p)',
      (secret) =>
        expectCode(
          () =>
            service.verify({
              header: service.sign(SECRET, PAYLOAD, NOW),
              payload: PAYLOAD,
              secret,
              nowSeconds: NOW,
            }),
          WebhookVerifyErrorCode.SECRET_UNAVAILABLE,
        ),
    );

    it('rejects a request with no signature header', () =>
      expectCode(
        () =>
          service.verify({
            payload: PAYLOAD,
            secret: SECRET,
            nowSeconds: NOW,
          }),
        WebhookVerifyErrorCode.MISSING_SIGNATURE,
      ));

    it.each([
      'not-a-signature',
      `t=${NOW}`,
      `v1=${'a'.repeat(64)}`,
      `t=${NOW},v1=zz${'a'.repeat(62)}`,
      `t=${NOW},v1=${'a'.repeat(63)}`,
      `t=${NOW},v1=${'a'.repeat(64)},x=1`,
    ])('rejects a malformed header (%p)', (header) =>
      expectCode(
        () =>
          service.verify({
            header,
            payload: PAYLOAD,
            secret: SECRET,
            nowSeconds: NOW,
          }),
        WebhookVerifyErrorCode.MALFORMED_HEADER,
      ),
    );

    it('rejects an oversized header before parsing it', async () => {
      const error = await expectCode(
        () =>
          service.verify({
            header: `t=${NOW},v1=${'a'.repeat(MAX_SIGNATURE_HEADER_BYTES)}`,
            payload: PAYLOAD,
            secret: SECRET,
            nowSeconds: NOW,
          }),
        WebhookVerifyErrorCode.HEADER_TOO_LARGE,
      );
      expect(error.message).not.toContain('a'.repeat(32));
    });
  });

  describe('replay window', () => {
    it('rejects a stale signature', () => {
      const stale = NOW - DEFAULT_SIGNATURE_TOLERANCE_SECONDS - 1;
      return expectCode(
        () =>
          service.verify({
            header: service.sign(SECRET, PAYLOAD, stale),
            payload: PAYLOAD,
            secret: SECRET,
            nowSeconds: NOW,
          }),
        WebhookVerifyErrorCode.TIMESTAMP_OUT_OF_TOLERANCE,
      );
    });

    it('rejects a future-dated signature', () => {
      const future = NOW + DEFAULT_SIGNATURE_TOLERANCE_SECONDS + 60;
      return expectCode(
        () =>
          service.verify({
            header: service.sign(SECRET, PAYLOAD, future),
            payload: PAYLOAD,
            secret: SECRET,
            nowSeconds: NOW,
          }),
        WebhookVerifyErrorCode.TIMESTAMP_OUT_OF_TOLERANCE,
      );
    });

    it.each([0, -1, Number.NaN, MAX_SIGNATURE_TOLERANCE_SECONDS + 1])(
      'refuses an unusable tolerance (%p)',
      (toleranceSeconds) =>
        expectCode(
          () =>
            service.verify({
              header: service.sign(SECRET, PAYLOAD, NOW),
              payload: PAYLOAD,
              secret: SECRET,
              nowSeconds: NOW,
              toleranceSeconds,
            }),
          WebhookVerifyErrorCode.INVALID_ARGUMENT,
        ),
    );
  });

  describe('no secret leakage', () => {
    it('never puts the secret, digest, or payload in an error', async () => {
      const header = service.sign(SECRET, PAYLOAD, NOW);
      const error = await expectCode(
        () =>
          service.verify({
            header,
            payload: PAYLOAD,
            secret: 'wrong-secret',
            nowSeconds: NOW,
          }),
        WebhookVerifyErrorCode.SIGNATURE_MISMATCH,
      );

      const serialized = `${error.message} ${error.stack ?? ''} ${
        error.code
      } ${JSON.stringify(Object.keys(error))}`;
      expect(serialized).not.toContain('wrong-secret');
      expect(serialized).not.toContain(SECRET);
      expect(serialized).not.toContain(header.split('v1=')[1]);
      expect(serialized).not.toContain(PAYLOAD);
    });

    it('emits a metric per rejection with no attacker data in the label', async () => {
      await expectCode(
        () =>
          service.verify({
            header: `t=${NOW},v1=${'a'.repeat(64)}`,
            payload: PAYLOAD,
            secret: SECRET,
            nowSeconds: NOW,
          }),
        WebhookVerifyErrorCode.SIGNATURE_MISMATCH,
      );

      expect(metrics.incrementCounter).toHaveBeenCalledWith(
        'webhook_signature_mismatch',
      );
    });
  });
});
