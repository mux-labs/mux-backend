import { ApiKeyAuditService } from './api-key-audit.service';

describe('ApiKeyAuditService.recent', () => {
  const buildService = () => {
    const prisma = {
      apiKeyAuditEvent: {
        findMany: jest.fn(),
      },
    };
    const service = new ApiKeyAuditService(prisma as any);
    return { service, prisma };
  };

  it('returns most recent events with newest last', async () => {
    const { service, prisma } = buildService();
    const events = [
      { id: '3', createdAt: new Date('2024-01-03T00:00:00Z') },
      { id: '2', createdAt: new Date('2024-01-02T00:00:00Z') },
      { id: '1', createdAt: new Date('2024-01-01T00:00:00Z') },
    ];
    prisma.apiKeyAuditEvent.findMany.mockResolvedValue(events);

    const result = await service.recent('key-1', 3);

    expect(result).toEqual(events);
    expect(result[result.length - 1]).toEqual(events[events.length - 1]);
  });

  it('bounds the result by the limit argument', async () => {
    const { service, prisma } = buildService();
    prisma.apiKeyAuditEvent.findMany.mockResolvedValue([]);

    await service.recent('key-1', 5);

    expect(prisma.apiKeyAuditEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 5 }),
    );
  });

  it('returns an empty list for a zero limit without throwing', async () => {
    const { service, prisma } = buildService();

    await expect(service.recent('key-1', 0)).resolves.toEqual([]);
    expect(prisma.apiKeyAuditEvent.findMany).not.toHaveBeenCalled();
  });

  it('returns an empty list for a negative limit without throwing', async () => {
    const { service, prisma } = buildService();

    await expect(service.recent('key-1', -1)).resolves.toEqual([]);
    expect(prisma.apiKeyAuditEvent.findMany).not.toHaveBeenCalled();
  });

  it('returns an empty list for a non-integer limit without throwing', async () => {
    const { service, prisma } = buildService();

    await expect(service.recent('key-1', 1.5)).resolves.toEqual([]);
    expect(prisma.apiKeyAuditEvent.findMany).not.toHaveBeenCalled();
  });
});
