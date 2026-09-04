import { KeyManagementMetricsService } from './key-management-metrics.service';

describe('KeyManagementMetricsService', () => {
  let service: KeyManagementMetricsService;
  let counter: any;
  let histogram: any;

  beforeEach(() => {
    const labeled = { inc: jest.fn() };
    counter = { labels: jest.fn().mockReturnValue(labeled) };
    histogram = { labels: jest.fn().mockReturnValue({ observe: jest.fn() }) };
    service = new KeyManagementMetricsService(counter, histogram);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('increments counter with operation and status labels', () => {
    service.incrementKeyOperations('GENERATE', 'success');
    expect(counter.labels).toHaveBeenCalledWith('GENERATE', 'success');
    expect(counter.labels('GENERATE', 'success').inc).toHaveBeenCalled();
  });

  it('records duration in histogram', () => {
    service.recordKeyOperationDuration('SIGN', 42);
    expect(histogram.labels).toHaveBeenCalledWith('SIGN');
    expect(histogram.labels('SIGN').observe).toHaveBeenCalledWith(42);
  });
});
