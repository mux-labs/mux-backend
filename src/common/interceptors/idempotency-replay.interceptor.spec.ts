import { Test } from '@nestjs/testing';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of } from 'rxjs';
import {
  IdempotencyReplayInterceptor,
  IdempotentResponse,
} from './idempotency-replay.interceptor';

describe('IdempotencyReplayInterceptor', () => {
  let interceptor: IdempotencyReplayInterceptor;
  let mockExecutionContext: ExecutionContext;
  let mockCallHandler: CallHandler;
  let mockResponse: any;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [IdempotencyReplayInterceptor],
    }).compile();

    interceptor = module.get<IdempotencyReplayInterceptor>(
      IdempotencyReplayInterceptor,
    );

    mockResponse = {
      setHeader: jest.fn(),
    };

    mockExecutionContext = {
      switchToHttp: jest.fn().mockReturnValue({
        getResponse: jest.fn().mockReturnValue(mockResponse),
      }),
    } as any;
  });

  it('should add idempotency headers when response contains replay metadata', (done) => {
    const idempotencyKey = 'test-key-123';
    const createdAt = new Date('2026-01-01T00:00:00Z');
    const responseData: IdempotentResponse = {
      data: { id: 'tx-123', amount: '100' },
      _idempotencyKey: idempotencyKey,
      _isReplay: true,
      _createdAt: createdAt,
    };

    mockCallHandler = {
      handle: jest.fn().mockReturnValue(of(responseData)),
    } as any;

    interceptor.intercept(mockExecutionContext, mockCallHandler).subscribe(
      (result) => {
        // Verify headers were set
        expect(mockResponse.setHeader).toHaveBeenCalledWith(
          'Idempotency-Key',
          idempotencyKey,
        );
        expect(mockResponse.setHeader).toHaveBeenCalledWith(
          'Idempotency-Replay',
          'true',
        );
        expect(mockResponse.setHeader).toHaveBeenCalledWith(
          'Idempotency-Created-At',
          createdAt.toISOString(),
        );

        // Verify metadata was stripped from response
        expect(result).not.toHaveProperty('_idempotencyKey');
        expect(result).not.toHaveProperty('_isReplay');
        expect(result).not.toHaveProperty('_createdAt');
        expect(result.data).toEqual({ id: 'tx-123', amount: '100' });

        done();
      },
    );
  });

  it('should not add Idempotency-Replay header when _isReplay is false', (done) => {
    const idempotencyKey = 'test-key-456';
    const createdAt = new Date('2026-01-01T00:00:00Z');
    const responseData: IdempotentResponse = {
      data: { id: 'tx-456', amount: '50' },
      _idempotencyKey: idempotencyKey,
      _isReplay: false,
      _createdAt: createdAt,
    };

    mockCallHandler = {
      handle: jest.fn().mockReturnValue(of(responseData)),
    } as any;

    interceptor.intercept(mockExecutionContext, mockCallHandler).subscribe(
      (result) => {
        // Verify Idempotency-Replay header was not set
        expect(mockResponse.setHeader).toHaveBeenCalledWith(
          'Idempotency-Key',
          idempotencyKey,
        );
        expect(mockResponse.setHeader).not.toHaveBeenCalledWith(
          'Idempotency-Replay',
          'true',
        );
        done();
      },
    );
  });

  it('should not modify response when no idempotency metadata is present', (done) => {
    const responseData = { id: 'tx-789', amount: '75' };

    mockCallHandler = {
      handle: jest.fn().mockReturnValue(of(responseData)),
    } as any;

    interceptor.intercept(mockExecutionContext, mockCallHandler).subscribe(
      (result) => {
        // Verify no headers were set
        expect(mockResponse.setHeader).not.toHaveBeenCalled();
        expect(result).toEqual(responseData);
        done();
      },
    );
  });

  it('should handle null response gracefully', (done) => {
    mockCallHandler = {
      handle: jest.fn().mockReturnValue(of(null)),
    } as any;

    interceptor.intercept(mockExecutionContext, mockCallHandler).subscribe(
      (result) => {
        expect(result).toBeNull();
        expect(mockResponse.setHeader).not.toHaveBeenCalled();
        done();
      },
    );
  });

  it('should strip all metadata fields from response body', (done) => {
    const responseData: IdempotentResponse = {
      data: { id: 'tx-999' },
      _idempotencyKey: 'key-999',
      _isReplay: true,
      _createdAt: new Date(),
    };

    mockCallHandler = {
      handle: jest.fn().mockReturnValue(of(responseData)),
    } as any;

    interceptor.intercept(mockExecutionContext, mockCallHandler).subscribe(
      (result) => {
        expect(result).toEqual({ data: { id: 'tx-999' } });
        done();
      },
    );
  });
});
