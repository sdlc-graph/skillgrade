import { describe, it, expect } from 'vitest';
import { parseGcsUri } from '../src/utils/gcs';

describe('parseGcsUri', () => {
    it('parses URI without prefix', () => {
        const result = parseGcsUri('gs://my-bucket');
        expect(result).toEqual({ bucket: 'my-bucket', prefix: '' });
    });

    it('parses URI with trailing slash', () => {
        const result = parseGcsUri('gs://my-bucket/');
        expect(result).toEqual({ bucket: 'my-bucket', prefix: '' });
    });

    it('parses URI with prefix', () => {
        const result = parseGcsUri('gs://my-bucket/reports');
        expect(result).toEqual({ bucket: 'my-bucket', prefix: 'reports' });
    });

    it('parses URI with nested prefix', () => {
        const result = parseGcsUri('gs://my-bucket/reports/2026');
        expect(result).toEqual({ bucket: 'my-bucket', prefix: 'reports/2026' });
    });
});
