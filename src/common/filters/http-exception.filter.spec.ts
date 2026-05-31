import { Test, TestingModule } from '@nestjs/testing';
import {
  HttpException,
  HttpStatus,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { HttpExceptionFilter, ErrorResponse } from './http-exception.filter';
import { ArgumentsHost } from '@nestjs/common';

describe('HttpExceptionFilter', () => {
  let filter: HttpExceptionFilter;
  let mockResponse: any;
  let mockRequest: any;
  let mockArgumentsHost: ArgumentsHost;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [HttpExceptionFilter],
    }).compile();

    filter = module.get<HttpExceptionFilter>(HttpExceptionFilter);

    // Mock response object
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    // Mock request object
    mockRequest = {
      url: '/api/test',
      method: 'GET',
      headers: {},
      ip: '127.0.0.1',
    };

    // Mock ArgumentsHost
    mockArgumentsHost = {
      switchToHttp: jest.fn().mockReturnValue({
        getResponse: () => mockResponse,
        getRequest: () => mockRequest,
      }),
      getArgByIndex: jest.fn(),
      getArgs: jest.fn(),
      getType: jest.fn(),
      switchToRpc: jest.fn(),
      switchToWs: jest.fn(),
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('HttpException handling', () => {
    it('should handle NotFoundException with structured response', () => {
      const exception = new NotFoundException('Resource not found');

      filter.catch(exception, mockArgumentsHost);

      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: HttpStatus.NOT_FOUND,
          message: 'Resource not found',
          error: 'Not Found',
          path: '/api/test',
          method: 'GET',
          timestamp: expect.any(String),
        }),
      );
    });

    it('should handle BadRequestException with structured response', () => {
      const exception = new BadRequestException('Invalid input');

      filter.catch(exception, mockArgumentsHost);

      expect(mockResponse.status).toHaveBeenCalledWith(
        HttpStatus.BAD_REQUEST,
      );
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: HttpStatus.BAD_REQUEST,
          message: 'Invalid input',
          error: 'Bad Request',
        }),
      );
    });

    it('should handle UnauthorizedException with structured response', () => {
      const exception = new UnauthorizedException('Invalid credentials');

      filter.catch(exception, mockArgumentsHost);

      expect(mockResponse.status).toHaveBeenCalledWith(
        HttpStatus.UNAUTHORIZED,
      );
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: HttpStatus.UNAUTHORIZED,
          message: 'Invalid credentials',
          error: 'Unauthorized',
        }),
      );
    });

    it('should handle ConflictException with structured response', () => {
      const exception = new ConflictException('Resource already exists');

      filter.catch(exception, mockArgumentsHost);

      expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: HttpStatus.CONFLICT,
          message: 'Resource already exists',
          error: 'Conflict',
        }),
      );
    });

    it('should handle HttpException with custom response object', () => {
      const exception = new HttpException(
        {
          statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
          message: 'Validation failed',
          error: 'Unprocessable Entity',
          details: {
            field: 'email',
            constraint: 'isEmail',
          },
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );

      filter.catch(exception, mockArgumentsHost);

      expect(mockResponse.status).toHaveBeenCalledWith(
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
          message: 'Validation failed',
          error: 'Unprocessable Entity',
          details: {
            field: 'email',
            constraint: 'isEmail',
          },
        }),
      );
    });

    it('should handle HttpException with array of messages', () => {
      const exception = new HttpException(
        {
          message: ['Field 1 is required', 'Field 2 must be a number'],
          error: 'Bad Request',
        },
        HttpStatus.BAD_REQUEST,
      );

      filter.catch(exception, mockArgumentsHost);

      const jsonCall = mockResponse.json.mock.calls[0][0];
      expect(jsonCall.message).toEqual([
        'Field 1 is required',
        'Field 2 must be a number',
      ]);
    });

    it('should handle HttpException with string response', () => {
      const exception = new HttpException(
        'Simple error message',
        HttpStatus.BAD_REQUEST,
      );

      filter.catch(exception, mockArgumentsHost);

      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Simple error message',
          error: 'Bad Request',
        }),
      );
    });
  });

  describe('Standard Error handling', () => {
    it('should handle standard Error objects', () => {
      const exception = new Error('Something went wrong');

      filter.catch(exception, mockArgumentsHost);

      expect(mockResponse.status).toHaveBeenCalledWith(
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          message: 'Something went wrong',
          error: 'Internal Server Error',
        }),
      );
    });

    it('should sanitize database URLs in error messages', () => {
      // Set NODE_ENV to production for sanitization
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      const exception = new Error(
        'Connection failed: postgresql://user:pass@localhost:5432/db',
      );

      filter.catch(exception, mockArgumentsHost);

      const jsonCall = mockResponse.json.mock.calls[0][0];
      expect(jsonCall.message).toContain('[DATABASE_URL]');
      expect(jsonCall.message).not.toContain('postgresql://');

      // Restore original NODE_ENV
      process.env.NODE_ENV = originalEnv;
    });

    it('should sanitize API keys in error messages', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      const exception = new Error('Invalid api_key: sk_test_12345');

      filter.catch(exception, mockArgumentsHost);

      const jsonCall = mockResponse.json.mock.calls[0][0];
      expect(jsonCall.message).toContain('[API_KEY]');
      expect(jsonCall.message).not.toContain('sk_test_12345');

      process.env.NODE_ENV = originalEnv;
    });

    it('should sanitize secrets in error messages', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      const exception = new Error('Failed with secret: my_secret_value');

      filter.catch(exception, mockArgumentsHost);

      const jsonCall = mockResponse.json.mock.calls[0][0];
      expect(jsonCall.message).toContain('[SECRET]');
      expect(jsonCall.message).not.toContain('my_secret_value');

      process.env.NODE_ENV = originalEnv;
    });
  });

  describe('Unknown exception handling', () => {
    it('should handle unknown exception types', () => {
      const exception = { unknown: 'error' };

      filter.catch(exception, mockArgumentsHost);

      expect(mockResponse.status).toHaveBeenCalledWith(
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          message: 'An unexpected error occurred',
          error: 'Internal Server Error',
        }),
      );
    });

    it('should handle null exception', () => {
      filter.catch(null, mockArgumentsHost);

      expect(mockResponse.status).toHaveBeenCalledWith(
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'An unexpected error occurred',
        }),
      );
    });

    it('should handle undefined exception', () => {
      filter.catch(undefined, mockArgumentsHost);

      expect(mockResponse.status).toHaveBeenCalledWith(
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    });
  });

  describe('Request context', () => {
    it('should include request path in error response', () => {
      mockRequest.url = '/api/wallets/123';
      const exception = new NotFoundException();

      filter.catch(exception, mockArgumentsHost);

      const jsonCall = mockResponse.json.mock.calls[0][0];
      expect(jsonCall.path).toBe('/api/wallets/123');
    });

    it('should include request method in error response', () => {
      mockRequest.method = 'POST';
      const exception = new BadRequestException();

      filter.catch(exception, mockArgumentsHost);

      const jsonCall = mockResponse.json.mock.calls[0][0];
      expect(jsonCall.method).toBe('POST');
    });

    it('should include timestamp in error response', () => {
      const exception = new NotFoundException();

      filter.catch(exception, mockArgumentsHost);

      const jsonCall = mockResponse.json.mock.calls[0][0];
      expect(jsonCall.timestamp).toBeDefined();
      expect(new Date(jsonCall.timestamp).toString()).not.toBe('Invalid Date');
    });

    it('should include request ID if present in headers', () => {
      mockRequest.headers['x-request-id'] = 'req-123-456';
      const exception = new NotFoundException();

      filter.catch(exception, mockArgumentsHost);

      const jsonCall = mockResponse.json.mock.calls[0][0];
      expect(jsonCall.requestId).toBe('req-123-456');
    });

    it('should not include request ID if not present', () => {
      const exception = new NotFoundException();

      filter.catch(exception, mockArgumentsHost);

      const jsonCall = mockResponse.json.mock.calls[0][0];
      expect(jsonCall.requestId).toBeUndefined();
    });
  });

  describe('Error response structure', () => {
    it('should always include required fields', () => {
      const exception = new NotFoundException('Test error');

      filter.catch(exception, mockArgumentsHost);

      const jsonCall = mockResponse.json.mock.calls[0][0];
      expect(jsonCall).toHaveProperty('statusCode');
      expect(jsonCall).toHaveProperty('timestamp');
      expect(jsonCall).toHaveProperty('path');
      expect(jsonCall).toHaveProperty('method');
      expect(jsonCall).toHaveProperty('message');
      expect(jsonCall).toHaveProperty('error');
    });

    it('should include details field when provided', () => {
      const exception = new HttpException(
        {
          message: 'Validation error',
          error: 'Bad Request',
          details: { field: 'email', reason: 'invalid format' },
        },
        HttpStatus.BAD_REQUEST,
      );

      filter.catch(exception, mockArgumentsHost);

      const jsonCall = mockResponse.json.mock.calls[0][0];
      expect(jsonCall.details).toEqual({
        field: 'email',
        reason: 'invalid format',
      });
    });

    it('should not include details field when not provided', () => {
      const exception = new NotFoundException('Not found');

      filter.catch(exception, mockArgumentsHost);

      const jsonCall = mockResponse.json.mock.calls[0][0];
      expect(jsonCall.details).toBeUndefined();
    });
  });

  describe('HTTP status code mapping', () => {
    const statusTests = [
      { status: HttpStatus.BAD_REQUEST, error: 'Bad Request' },
      { status: HttpStatus.UNAUTHORIZED, error: 'Unauthorized' },
      { status: HttpStatus.FORBIDDEN, error: 'Forbidden' },
      { status: HttpStatus.NOT_FOUND, error: 'Not Found' },
      { status: HttpStatus.CONFLICT, error: 'Conflict' },
      {
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        error: 'Unprocessable Entity',
      },
      { status: HttpStatus.TOO_MANY_REQUESTS, error: 'Too Many Requests' },
      {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        error: 'Internal Server Error',
      },
      { status: HttpStatus.BAD_GATEWAY, error: 'Bad Gateway' },
      { status: HttpStatus.SERVICE_UNAVAILABLE, error: 'Service Unavailable' },
      { status: HttpStatus.GATEWAY_TIMEOUT, error: 'Gateway Timeout' },
    ];

    statusTests.forEach(({ status, error }) => {
      it(`should map ${status} to "${error}"`, () => {
        const exception = new HttpException('Test', status);

        filter.catch(exception, mockArgumentsHost);

        const jsonCall = mockResponse.json.mock.calls[0][0];
        expect(jsonCall.error).toBe(error);
      });
    });
  });
});
