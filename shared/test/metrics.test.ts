/**
 * Copyright (c) 2026 stellar-compliance-kit
 * SPDX-License-Identifier: MIT
 */

/**
 * Tests for combineExpositions helper.
 * Issue #300: Combine multiple registries' metrics into a single Prometheus exposition.
 */

import { combineExpositions } from '../src/metrics';

describe('combineExpositions', () => {
  it('merges multiple Prometheus expositions into a single valid output', () => {
    const exposition1 = `# HELP metric_a Counter for A
# TYPE metric_a counter
metric_a 10
`;

    const exposition2 = `# HELP metric_b Counter for B
# TYPE metric_b counter
metric_b 20
`;

    const combined = combineExpositions([exposition1, exposition2]);

    expect(combined).toContain('metric_a 10');
    expect(combined).toContain('metric_b 20');
    expect(combined).toContain('# HELP metric_a Counter for A');
    expect(combined).toContain('# HELP metric_b Counter for B');
  });

  it('deduplicates TYPE declarations for identical metric names', () => {
    const exposition1 = `# HELP requests_total Total requests
# TYPE requests_total counter
requests_total{handler="a"} 100
`;

    const exposition2 = `# HELP requests_total Total requests
# TYPE requests_total counter
requests_total{handler="b"} 50
`;

    const combined = combineExpositions([exposition1, exposition2]);

    // Should have exactly one # TYPE declaration for requests_total
    const typeLines = combined.split('\n').filter((line) => line.includes('# TYPE requests_total'));
    expect(typeLines).toHaveLength(1);

    // Both metric values should be present
    expect(combined).toContain('requests_total{handler="a"} 100');
    expect(combined).toContain('requests_total{handler="b"} 50');
  });

  it('preserves HELP and TYPE headers in valid Prometheus format', () => {
    const exposition = `# HELP requests_total Total requests
# TYPE requests_total counter
requests_total 42
`;

    const combined = combineExpositions([exposition]);

    // Verify Prometheus exposition format is maintained
    expect(combined).toMatch(/# HELP \w+ .*/);
    expect(combined).toMatch(/# TYPE \w+ \w+/);
  });

  it('handles empty expositions gracefully', () => {
    const exposition1 = `# HELP metric_a Counter
# TYPE metric_a counter
metric_a 10
`;

    const exposition2 = '';

    const combined = combineExpositions([exposition1, exposition2]);

    expect(combined).toContain('metric_a 10');
  });

  it('orders metrics consistently (alphabetical by metric name)', () => {
    const exposition1 = `# HELP zebra_metric Z metric
# TYPE zebra_metric counter
zebra_metric 1
`;

    const exposition2 = `# HELP alpha_metric A metric
# TYPE alpha_metric counter
alpha_metric 2
`;

    const combined = combineExpositions([exposition1, exposition2]);

    // Extract line order (ignoring whitespace)
    const lines = combined.split('\n').filter((line) => line.trim());
    const metricLine = lines.find((line) => line.includes('alpha_metric'));
    const zebraLine = lines.find((line) => line.includes('zebra_metric'));

    expect(metricLine).toBeDefined();
    expect(zebraLine).toBeDefined();
    expect(lines.indexOf(metricLine as string)).toBeLessThan(lines.indexOf(zebraLine as string));
  });

  it('merges histogram metrics with multiple buckets and labels', () => {
    const exposition1 = `# HELP response_time Response time
# TYPE response_time histogram
response_time_bucket{le="0.1"} 5
response_time_bucket{le="1"} 10
response_time_sum 50
response_time_count 10
`;

    const exposition2 = `# HELP response_time Response time
# TYPE response_time histogram
response_time_bucket{le="0.1"} 3
response_time_bucket{le="1"} 8
response_time_sum 40
response_time_count 8
`;

    const combined = combineExpositions([exposition1, exposition2]);

    // All histogram lines should be present
    expect(combined).toContain('response_time_bucket{le="0.1"} 5');
    expect(combined).toContain('response_time_bucket{le="1"} 10');
    expect(combined).toContain('response_time_bucket{le="0.1"} 3');
    expect(combined).toContain('response_time_bucket{le="1"} 8');

    // Should have exactly one TYPE declaration
    const typeLines = combined.split('\n').filter((line) => line.includes('# TYPE response_time'));
    expect(typeLines).toHaveLength(1);
  });

  it('handles gauge metrics from multiple registries', () => {
    const exposition1 = `# HELP memory_bytes Memory usage
# TYPE memory_bytes gauge
memory_bytes{type="heap"} 1024
`;

    const exposition2 = `# HELP memory_bytes Memory usage
# TYPE memory_bytes gauge
memory_bytes{type="stack"} 512
`;

    const combined = combineExpositions([exposition1, exposition2]);

    expect(combined).toContain('memory_bytes{type="heap"} 1024');
    expect(combined).toContain('memory_bytes{type="stack"} 512');

    // Verify only one TYPE declaration exists
    const typeCount = combined.split('\n').filter((line) => line.includes('# TYPE memory_bytes'))
      .length;
    expect(typeCount).toBe(1);
  });

  it('combines three or more registries without loss of data', () => {
    const exposition1 = '# HELP metric1 M1\n# TYPE metric1 counter\nmetric1 10\n';
    const exposition2 = '# HELP metric2 M2\n# TYPE metric2 counter\nmetric2 20\n';
    const exposition3 = '# HELP metric3 M3\n# TYPE metric3 counter\nmetric3 30\n';

    const combined = combineExpositions([exposition1, exposition2, exposition3]);

    expect(combined).toContain('metric1 10');
    expect(combined).toContain('metric2 20');
    expect(combined).toContain('metric3 30');

    // Each metric should have exactly one TYPE declaration
    expect(combined.split('\n').filter((line) => line.includes('# TYPE metric1'))).toHaveLength(1);
    expect(combined.split('\n').filter((line) => line.includes('# TYPE metric2'))).toHaveLength(1);
    expect(combined.split('\n').filter((line) => line.includes('# TYPE metric3'))).toHaveLength(1);
  });

  it('produces valid output when passed a single exposition', () => {
    const exposition = `# HELP http_requests Total HTTP requests
# TYPE http_requests counter
http_requests{method="GET"} 100
http_requests{method="POST"} 50
`;

    const combined = combineExpositions([exposition]);

    expect(combined).toBe(exposition);
  });

  it('returns empty string for empty input array', () => {
    const combined = combineExpositions([]);

    expect(combined).toBe('');
  });
});
