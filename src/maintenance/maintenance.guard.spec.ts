import { ServiceUnavailableException } from '@nestjs/common';
import { MaintenanceGuard } from './maintenance.guard';

function context(method: string) {
  const response = { setHeader: jest.fn() };
  return {
    response,
    value: {
      switchToHttp: () => ({
        getRequest: () => ({ method }),
        getResponse: () => response,
      }),
      getHandler: () => function handler() {},
      getClass: () => class Controller {},
    } as any,
  };
}

describe('MaintenanceGuard', () => {
  const maintenance = { getStatus: jest.fn() };
  const reflector = { getAllAndOverride: jest.fn() };
  const guard = new MaintenanceGuard(maintenance as any, reflector as any);

  beforeEach(() => jest.clearAllMocks());

  it('allows read-only routes without querying persistence', async () => {
    const { value } = context('GET');
    await expect(guard.canActivate(value)).resolves.toBe(true);
    expect(maintenance.getStatus).not.toHaveBeenCalled();
  });

  it('allows mutating routes when maintenance mode is disabled', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    maintenance.getStatus.mockResolvedValue({ enabled: false });
    const { value } = context('POST');
    await expect(guard.canActivate(value)).resolves.toBe(true);
  });

  it('blocks mutating routes with 503 and Retry-After when enabled', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    maintenance.getStatus.mockResolvedValue({
      enabled: true,
      message: 'Planned maintenance',
      retryAfterSeconds: 60,
    });
    const { value, response } = context('PATCH');

    await expect(guard.canActivate(value)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '60');
  });

  it('fails closed when maintenance state cannot be read', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    maintenance.getStatus.mockRejectedValue(new Error('database unavailable'));
    const { value } = context('DELETE');
    await expect(guard.canActivate(value)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
