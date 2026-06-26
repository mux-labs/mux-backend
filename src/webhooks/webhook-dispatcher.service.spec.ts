import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { WebhookSignerService } from './webhook-signer.service';
import { PrismaService } from '../prisma/prisma.service';
import { RequestContext } from '../common/context/request-context';
import {
  DeliveryStatus,
  EndpointStatus,
  WebhookEventType,
} from './domain/webhook-events';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const ENDPOINT_ID = 'endpoint-1';
const DELIVERY_ID = 'delivery-1';
const REQUEST_ID = 'test-request-id-379';

const mockDelivery = {
  id: DELIVERY_ID,
  endpointId: ENDPOINT_ID,
  eventId: 'event-1',
  eventType: WebhookEventType.WALLET_CREATED,
  payload: { id: 'event-1', type: WebhookEventType.WALLET_CREATED },
  status: DeliveryStatus.PENDING,
  attempts: 0,
  endpoint: {
    id: ENDPOINT_ID,
    url: 'https://example.com/hook',
    secret: 'whsec_test',
    status: EndpointStatus.ACTIVE,
  },
};

describe('WebhookDispatcherService (request ID propagation)', () => {
  let service: WebhookDispatcherService;

  const mockPrisma = {
    webhookDelivery: {
      findMany: jest.fn(),
      update: jest.fn(),
    },
    webhookEndpoint: {
      update: jest.fn(),
    },
  };

  const mockSigner = {
    generateSignatureHeaders: jest.fn().mockReturnValue({
      timestamp: 1234567890,
      signature: 'sig',
    }),
    formatSignatureHeader: jest.fn().mockReturnValue('t=1234567890,v1=sig'),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockedAxios.post.mockResolvedValue({ status: 200, data: { ok: true } });
    mockPrisma.webhookDelivery.findMany.mockResolvedValue([mockDelivery]);
    mockPrisma.webhookDelivery.update.mockResolvedValue({});
    mockPrisma.webhookEndpoint.update.mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookDispatcherService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: WebhookSignerService, useValue: mockSigner },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((_key: string, defaultValue?: unknown) => defaultValue),
          },
        },
      ],
    }).compile();

    service = module.get<WebhookDispatcherService>(WebhookDispatcherService);
  });

  it('forwards x-request-id on outbound webhook HTTP calls when present in context', async () => {
    await RequestContext.run(REQUEST_ID, async () => {
      await service.processDeliveries();
    });

    expect(mockedAxios.post).toHaveBeenCalledWith(
      mockDelivery.endpoint.url,
      mockDelivery.payload,
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-request-id': REQUEST_ID,
        }),
      }),
    );
  });

  it('omits x-request-id on outbound calls when no request context exists', async () => {
    await service.processDeliveries();

    const callHeaders = mockedAxios.post.mock.calls[0][2]?.headers as Record<
      string,
      string
    >;
    expect(callHeaders['x-request-id']).toBeUndefined();
  });
});
