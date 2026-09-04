import { Test, TestingModule } from '@nestjs/testing';
import * as https from 'https';
import {
  WebhookDispatchService,
  WebhookMtlsConfig,
} from './webhook-dispatch.service';
import { WebhookSignerService } from './webhook-signer.service';
import { MetricsService } from '../common/metrics/metrics.service';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

jest.mock('axios');
jest.mock('https');

describe('WebhookDispatchService', () => {
  let service: WebhookDispatchService;
  let mockSigner: any;
  let mockMetrics: any;
  let mockConfigService: any;
  let mockAxiosInstance: {
    post: jest.Mock;
    interceptors: { request: { use: jest.Mock } };
  };

  beforeEach(async () => {
    // Build the mock axios instance that createRequestIdAwareAxios will receive
    mockAxiosInstance = {
      post: jest.fn(),
      interceptors: {
        request: {
          use: jest.fn(),
        },
      },
    };
    (axios.create as jest.Mock).mockReturnValue(mockAxiosInstance);

    mockSigner = {
      generateSignatureHeaders: jest.fn(() => ({
        timestamp: Math.floor(Date.now() / 1000),
        signature: 'sig_test',
      })),
      formatSignatureHeader: jest.fn(() => 't=123,v1=sig_test'),
    };

    mockMetrics = {
      incrementCounter: jest.fn(),
      recordHistogram: jest.fn(),
    };

    mockConfigService = {
      get: jest.fn((key: string, defaultValue: any) => defaultValue),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookDispatchService,
        { provide: WebhookSignerService, useValue: mockSigner },
        { provide: MetricsService, useValue: mockMetrics },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<WebhookDispatchService>(WebhookDispatchService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('deliverWebhook', () => {
    it('should successfully deliver a webhook', async () => {
      mockAxiosInstance.post.mockResolvedValue({
        status: 200,
        data: { success: true },
      });

      const result = await service.deliverWebhook(
        'https://example.com/webhook',
        { test: 'payload' },
        'wallet.created',
        'evt-123',
        'whsec_secret',
      );

      expect(result.success).toBe(true);
      expect(result.responseStatus).toBe(200);
      expect(result.responseTime).toBeDefined();
      expect(mockAxiosInstance.post).toHaveBeenCalled();
    });

    it('should include signature headers in request', async () => {
      mockAxiosInstance.post.mockResolvedValue({
        status: 200,
        data: { success: true },
      });

      await service.deliverWebhook(
        'https://example.com/webhook',
        { test: 'payload' },
        'wallet.created',
        'evt-123',
        'whsec_secret',
      );

      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        'https://example.com/webhook',
        { test: 'payload' },
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Webhook-Signature': expect.any(String),
            'X-Webhook-Event-Type': 'wallet.created',
            'X-Webhook-Event-Id': 'evt-123',
          }),
        }),
      );
    });

    it('should handle delivery failure', async () => {
      mockAxiosInstance.post.mockRejectedValue(new Error('Connection refused'));

      const result = await service.deliverWebhook(
        'https://example.com/webhook',
        { test: 'payload' },
        'wallet.created',
        'evt-123',
        'whsec_secret',
      );

      expect(result.success).toBe(false);
      expect(result.errorMessage).toBeDefined();
      expect(result.responseTime).toBeDefined();
    });

    it('propagates x-request-id via the request-id-aware axios instance', async () => {
      mockAxiosInstance.post.mockResolvedValue({
        status: 200,
        data: { success: true },
      });

      // Verify the interceptor was registered
      expect(mockAxiosInstance.interceptors.request.use).toHaveBeenCalled();
    });

    describe('mTLS support', () => {
      const mtlsConfig: WebhookMtlsConfig = {
        cert: '-----BEGIN CERTIFICATE-----\nSTUB\n-----END CERTIFICATE-----',
        key: '-----BEGIN PRIVATE KEY-----\nSTUB\n-----END PRIVATE KEY-----',
      };

      it('should attach an https.Agent when mTLS config is provided', async () => {
        mockAxiosInstance.post.mockResolvedValue({
          status: 200,
          data: { ok: true },
        });

        const agentSpy = jest
          .spyOn(https, 'Agent')
          .mockImplementation(() => ({}) as any);

        await service.deliverWebhook(
          'https://secure.example.com/webhook',
          { event: 'test' },
          'payment.created',
          'evt-456',
          'whsec_secret',
          mtlsConfig,
        );

        // The post call should include an httpsAgent
        const callArgs = mockAxiosInstance.post.mock.calls[0][2];
        expect(callArgs).toHaveProperty('httpsAgent');

        agentSpy.mockRestore();
      });

      it('should not attach an https.Agent when mTLS config is absent', async () => {
        mockAxiosInstance.post.mockResolvedValue({
          status: 200,
          data: { ok: true },
        });

        await service.deliverWebhook(
          'https://example.com/webhook',
          { event: 'test' },
          'payment.created',
          'evt-789',
          'whsec_secret',
        );

        const callArgs = mockAxiosInstance.post.mock.calls[0][2];
        expect(callArgs).not.toHaveProperty('httpsAgent');
      });

      it('should pass cert and key (but not log them) to the https.Agent', async () => {
        mockAxiosInstance.post.mockResolvedValue({
          status: 200,
          data: { ok: true },
        });

        const agentSpy = jest
          .spyOn(https, 'Agent')
          .mockImplementation(() => ({}) as any);

        await service.deliverWebhook(
          'https://secure.example.com/webhook',
          { event: 'test' },
          'payment.created',
          'evt-mtls',
          'whsec_secret',
          mtlsConfig,
        );

        expect(agentSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            cert: mtlsConfig.cert,
            key: mtlsConfig.key,
          }),
        );

        agentSpy.mockRestore();
      });

      it('should include optional CA cert in the https.Agent when provided', async () => {
        mockAxiosInstance.post.mockResolvedValue({
          status: 200,
          data: { ok: true },
        });

        const agentSpy = jest
          .spyOn(https, 'Agent')
          .mockImplementation(() => ({}) as any);

        const mtlsWithCa: WebhookMtlsConfig = {
          ...mtlsConfig,
          ca: '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----',
        };

        await service.deliverWebhook(
          'https://secure.example.com/webhook',
          { event: 'test' },
          'payment.created',
          'evt-ca',
          'whsec_secret',
          mtlsWithCa,
        );

        expect(agentSpy).toHaveBeenCalledWith(
          expect.objectContaining({ ca: mtlsWithCa.ca }),
        );

        agentSpy.mockRestore();
      });

      it('should return success:false and not expose cert details when mTLS delivery fails', async () => {
        mockAxiosInstance.post.mockRejectedValue(
          Object.assign(new Error('certificate verify failed'), {
            code: 'CERT_VERIFY_FAILED',
          }),
        );

        const result = await service.deliverWebhook(
          'https://secure.example.com/webhook',
          { event: 'test' },
          'payment.created',
          'evt-fail',
          'whsec_secret',
          mtlsConfig,
        );

        expect(result.success).toBe(false);
        expect(result.errorMessage).toBeDefined();
        // Cert material must not leak into error messages
        expect(result.errorMessage).not.toContain(mtlsConfig.cert);
        expect(result.errorMessage).not.toContain(mtlsConfig.key);
      });
    });
  });

  describe('isRetryableError', () => {
    it('should return true for connection errors', () => {
      const error = new Error('Connection refused') as any;
      error.code = 'ECONNREFUSED';

      expect(service.isRetryableError(error)).toBe(true);
    });

    it('should return true for timeout errors', () => {
      const error = new Error('Timeout') as any;
      error.code = 'ETIMEDOUT';

      expect(service.isRetryableError(error)).toBe(true);
    });

    it('should return true for 500 server errors', () => {
      const error = new Error('Server error') as any;
      error.response = { status: 500 };

      expect(service.isRetryableError(error)).toBe(true);
    });

    it('should return false for 4xx client errors', () => {
      const error = new Error('Bad request') as any;
      error.response = { status: 400 };

      expect(service.isRetryableError(error)).toBe(false);
    });
  });
});
