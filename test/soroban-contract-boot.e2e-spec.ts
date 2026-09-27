/**
 * Contract ID boot validation — e2e test (#954)
 *
 * WHY THIS EXISTS
 * The invoke surface is deny-by-default behind `SOROBAN_INVOKE_ENABLED`, but
 * once an operator turns it on, nothing checked that the configured contract ids
 * were actually usable. A truncated paste, a G-address in the wrong variable, or
 * the testnet id copied into the mainnet variable would only surface as a
 * confusing RPC failure on the first live invoke.
 *
 * This suite drives the real provider through the Nest DI container and asserts
 * the boot gate refuses to start a misconfigured deployment, and that a
 * correctly configured one starts cleanly.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { SorobanContractBootValidatorService } from '../src/soroban/soroban-contract-boot-validator.service';

const TESTNET_ID = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';
const MAINNET_ID = 'CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ';

describe('Soroban contract id boot validation (e2e, #954)', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  /** Compiles the provider and runs its onModuleInit lifecycle hook. */
  const boot = async (
    env: NodeJS.ProcessEnv,
  ): Promise<{ ok: boolean; message: string }> => {
    process.env = env;
    const module: TestingModule = await Test.createTestingModule({
      providers: [SorobanContractBootValidatorService],
    }).compile();

    // Instantiating the provider and running init is what a real boot does.
    module.get(SorobanContractBootValidatorService);
    try {
      await module.init();
      return { ok: true, message: '' };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  };

  const validEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    SOROBAN_INVOKE_ENABLED: 'true',
    SOROBAN_CONTRACT_WALLET_REGISTRY_TESTNET_ID: TESTNET_ID,
    SOROBAN_CONTRACT_WALLET_REGISTRY_MAINNET_ID: MAINNET_ID,
    SOROBAN_CONTRACT_SPEND_LIMIT_TESTNET_ID: TESTNET_ID,
    ...extra,
  });

  it('boots when the surface is disabled and nothing is configured', async () => {
    const { ok } = await boot({ SOROBAN_INVOKE_ENABLED: 'false' });

    expect(ok).toBe(true);
  });

  it('boots when the surface is disabled and no flag is set at all', async () => {
    const { ok } = await boot({});

    expect(ok).toBe(true);
  });

  it('boots when the surface is enabled and every id is valid', async () => {
    const { ok } = await boot(validEnv());

    expect(ok).toBe(true);
  });

  it('refuses to boot when an allowlisted contract has no id', async () => {
    const env = validEnv();
    delete env.SOROBAN_CONTRACT_WALLET_REGISTRY_MAINNET_ID;

    const { ok, message } = await boot(env);

    expect(ok).toBe(false);
    expect(message).toContain('SOROBAN_CONTRACT_ID_MISSING');
  });

  it('refuses to boot on a malformed id', async () => {
    const { ok, message } = await boot(
      validEnv({ SOROBAN_CONTRACT_SPEND_LIMIT_TESTNET_ID: 'nope' }),
    );

    expect(ok).toBe(false);
    expect(message).toContain('SOROBAN_CONTRACT_ID_INVALID');
  });

  it('refuses to boot when the same id is configured for both networks', async () => {
    const { ok, message } = await boot(
      validEnv({ SOROBAN_CONTRACT_WALLET_REGISTRY_MAINNET_ID: TESTNET_ID }),
    );

    expect(ok).toBe(false);
    expect(message).toContain('SOROBAN_CONTRACT_ID_NETWORK_COLLISION');
  });

  it('names every offending variable so an operator can fix them in one pass', async () => {
    const { ok, message } = await boot({
      SOROBAN_INVOKE_ENABLED: 'true',
    });

    expect(ok).toBe(false);
    expect(message).toContain('SOROBAN_CONTRACT_WALLET_REGISTRY_TESTNET_ID');
    expect(message).toContain('SOROBAN_CONTRACT_WALLET_REGISTRY_MAINNET_ID');
    expect(message).toContain('SOROBAN_CONTRACT_SPEND_LIMIT_TESTNET_ID');
    // The message must name the kill-switch, not just the failure.
    expect(message).toContain('SOROBAN_INVOKE_ENABLED=false');
  });

  it('never prints a configured id value in the failure output', async () => {
    const { message } = await boot(
      validEnv({
        SOROBAN_CONTRACT_SPEND_LIMIT_TESTNET_ID: 'leaky-id-value',
      }),
    );

    expect(message).not.toContain('leaky-id-value');
    // ...nor the valid ids it is complaining about alongside it.
    expect(message).not.toContain(MAINNET_ID);
  });

  it('does not demand a mainnet id for the testnet-only spend_limit contract', async () => {
    const { ok } = await boot(validEnv({ SOROBAN_INVOKE_ENABLED: 'true' }));

    expect(ok).toBe(true);
  });

  it('is idempotent: a valid configuration boots on repeated attempts', async () => {
    expect((await boot(validEnv())).ok).toBe(true);
    expect((await boot(validEnv())).ok).toBe(true);
  });
});
