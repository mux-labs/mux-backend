import { Logger, ServiceUnavailableException } from '@nestjs/common';

import { MetricsService } from '../common/metrics/metrics.service';
import {
  InvokeErrorCode,
  SOROBAN_INVOKE_ENABLED_ENV,
  SorobanNetwork,
} from './soroban-invoke.model';
import type { InvokeActor, InvokeRequest } from './soroban-invoke.model';
import {
  ContractRegistryPort,
  SorobanInvokeService,
  SorobanRpcPort,
} from './soroban-invoke.service';

/**
 * Regression tests for `SorobanInvokeService.assertEnabled` (issue #1339):
 *
 *   Deny-by-default gate. Nothing is invoked until an operator opts in.
 */

const CORRELATION_ID = 'corr-assert-enabled-1339';

describe('SorobanInvokeService.assertEnabled (#1339)', () => {
  const originalFlag = process.env[SOROBAN_INVOKE_ENABLED_ENV];

  let incrementCounter: jest.Mock;
  let warnSpy: jest.SpyInstance;
  let service: SorobanInvokeService;

  const assertEnabled = (correlationId = CORRELATION_ID): void =>
    (
      service as unknown as { assertEnabled(correlationId: string): void }
    ).assertEnabled(correlationId);

  const setFlag = (value: string | undefined): void => {
    if (value === undefined) {
      delete process.env[SOROBAN_INVOKE_ENABLED_ENV];
    } else {
      process.env[SOROBAN_INVOKE_ENABLED_ENV] = value;
    }
  };

  const captureError = (fn: () => void): ServiceUnavailableException => {
    try {
      fn();
    } catch (error) {
      return error as ServiceUnavailableException;
    }
    throw new Error('expected assertEnabled to throw');
  };

  beforeEach(() => {
    incrementCounter = jest.fn();
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    service = new SorobanInvokeService(undefined, undefined, {
      incrementCounter,
    } as unknown as MetricsService);
    setFlag(undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    setFlag(originalFlag);
  });

  describe('deny by default', () => {
    it('refuses when the flag is unset', () => {
      const error = captureError(() => assertEnabled());

      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(error.getResponse()).toEqual({
        code: InvokeErrorCode.FEATURE_FLAG_DISABLED,
        message: `Soroban invoke is disabled; set ${SOROBAN_INVOKE_ENABLED_ENV}=true to enable`,
        correlationId: CORRELATION_ID,
      });
    });

    it.each([
      '',
      'false',
      '0',
      'no',
      'off',
      'yes',
      'on',
      'TRUE',
      'True',
      ' true',
      'true ',
      '1 ',
      '01',
      'enabled',
    ])('refuses anything but an explicit opt-in (flag=%p)', (value) => {
      setFlag(value);

      expect(() => assertEnabled()).toThrow(ServiceUnavailableException);
      expect(service.isInvokeEnabled()).toBe(false);
    });

    it('records the refusal as a metric and a correlated warning', () => {
      captureError(() => assertEnabled());

      expect(incrementCounter).toHaveBeenCalledTimes(1);
      expect(incrementCounter).toHaveBeenCalledWith(
        'soroban_invoke_blocked_by_flag',
      );
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [warning] = warnSpy.mock.calls[0] as [string];
      expect(warning).toContain(`correlationId=${CORRELATION_ID}`);
    });

    it('re-reads the flag per call, so revoking the opt-in closes the gate', () => {
      setFlag('true');
      expect(() => assertEnabled()).not.toThrow();

      setFlag('false');
      expect(() => assertEnabled()).toThrow(ServiceUnavailableException);
    });
  });

  describe('operator opt-in', () => {
    it.each(['true', '1'])('allows flag=%p without side effects', (value) => {
      setFlag(value);

      expect(() => assertEnabled()).not.toThrow();
      expect(incrementCounter).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('nothing is invoked until the operator opts in', () => {
    const request: InvokeRequest = {
      contract: 'any-contract',
      functionName: 'any_function',
      args: [],
      network: SorobanNetwork.TESTNET,
    };

    it('rejects invoke() before touching the RPC or the contract registry', async () => {
      const simulate = jest.fn();
      const submit = jest.fn();
      const resolveContractId = jest.fn();
      const rpc = { simulate, submit } as unknown as SorobanRpcPort;
      const registry: ContractRegistryPort = { resolveContractId };
      service = new SorobanInvokeService(rpc, registry, {
        incrementCounter,
      } as unknown as MetricsService);
      const actor: InvokeActor = {
        subjectId: 'owner-1',
        role: 'owner',
        correlationId: CORRELATION_ID,
      };

      await expect(service.invoke(request, actor)).rejects.toMatchObject({
        response: { code: InvokeErrorCode.FEATURE_FLAG_DISABLED },
      });

      expect(resolveContractId).not.toHaveBeenCalled();
      expect(simulate).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
    });

    it('runs before authorization, so even a refused role sees the flag error', async () => {
      const actor: InvokeActor = {
        subjectId: 'delegate-1',
        role: 'delegate',
        correlationId: CORRELATION_ID,
      };

      await expect(service.invoke(request, actor)).rejects.toMatchObject({
        response: { code: InvokeErrorCode.FEATURE_FLAG_DISABLED },
      });
      expect(incrementCounter).toHaveBeenCalledWith(
        'soroban_invoke_blocked_by_flag',
      );
      expect(incrementCounter).not.toHaveBeenCalledWith(
        'soroban_invoke_authz_denied',
      );
    });
  });
});
