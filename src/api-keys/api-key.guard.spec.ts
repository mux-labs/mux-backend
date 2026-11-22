import { attachContext } from './api-key.guard';

describe('attachContext', () => {
  const buildValidationResult = () => ({
    apiKey: { id: 'key_1', projectId: 'proj_1' },
    project: { id: 'proj_1', name: 'Project One' },
    developer: { id: 'dev_1', email: 'dev@example.com' },
    context: { projectId: 'proj_1', developerId: 'dev_1' },
    info: { rateLimit: 100, billingPlan: 'pro' },
  });

  it('attaches the raw validation result to request.apiKey', () => {
    const request: any = {};
    const result = buildValidationResult();

    attachContext(request, result as any);

    expect(request.apiKey).toBe(result);
    expect(request.apiKey.project).toBe(result.project);
    expect(request.apiKey.developer).toBe(result.developer);
  });

  it('attaches the flattened ops-safe view to request.apiKeyContext', () => {
    const request: any = {};
    const result = buildValidationResult();

    attachContext(request, result as any);

    expect(request.apiKeyContext).toEqual(result.context);
  });

  it('attaches the billing/rate-limit view to request.apiKeyInfo', () => {
    const request: any = {};
    const result = buildValidationResult();

    attachContext(request, result as any);

    expect(request.apiKeyInfo).toEqual(result.info);
  });

  it('derives the developer identity from the key, never from the request body', () => {
    const request: any = { body: { developerId: 'attacker_dev' } };
    const result = buildValidationResult();

    attachContext(request, result as any);

    expect(request.apiKey.developer.id).toBe('dev_1');
    expect(request.apiKeyContext.developerId).toBe('dev_1');
    expect(request.apiKey.developer.id).not.toBe(request.body.developerId);
  });

  it('does not attach context when the validation result is missing', () => {
    const request: any = {};

    expect(() => attachContext(request, undefined as any)).toThrow();
    expect(request.apiKey).toBeUndefined();
    expect(request.apiKeyContext).toBeUndefined();
    expect(request.apiKeyInfo).toBeUndefined();
  });
});
