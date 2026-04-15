import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs-extra';
import * as path from 'path';
import { getReportStore, LocalReportStore, GcsReportStore } from '../src/core/storage';

vi.mock('fs-extra', () => ({
    readdir: vi.fn(),
    readJSON: vi.fn(),
    ensureDir: vi.fn(),
    writeJSON: vi.fn(),
    remove: vi.fn(),
}));

vi.mock('@google-cloud/storage', () => {
    const fileMock = {
        download: vi.fn().mockResolvedValue([Buffer.from(JSON.stringify({ task: 'test' }))]),
        save: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
    };
    const bucketMock = {
        getFiles: vi.fn().mockResolvedValue([[{ name: 'report1.json' }]]),
        file: vi.fn().mockReturnValue(fileMock),
    };
    return {
        Storage: function StorageMock(this: any) {
            this.bucket = vi.fn().mockReturnValue(bucketMock);
        },
    };
});

describe('ReportStore', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('getReportStore', () => {
        it('returns a LocalReportStore for local paths', () => {
            const store = getReportStore('/tmp/reports');
            expect(store).toBeInstanceOf(LocalReportStore);
        });

        it('returns a GcsReportStore for gs:// paths', () => {
            const store = getReportStore('gs://my-bucket/reports');
            expect(store).toBeInstanceOf(GcsReportStore);
        });
    });

    describe('LocalReportStore', () => {
        it('lists reports from local directory', async () => {
            const store = new LocalReportStore('/tmp/reports');
            vi.mocked(fs.readdir).mockResolvedValue(['report1.json'] as any);
            vi.mocked(fs.readJSON).mockResolvedValue({ task: 'test' });

            const reports = await store.listReports();
            expect(fs.readdir).toHaveBeenCalledWith('/tmp/reports');
            expect(reports).toHaveLength(1);
        });

        it('saves reports to local directory', async () => {
            const store = new LocalReportStore('/tmp/reports');
            await store.saveReport('report1.json', { task: 'test' } as any);

            expect(fs.ensureDir).toHaveBeenCalledWith('/tmp/reports');
            expect(fs.writeJSON).toHaveBeenCalledWith(
                path.join('/tmp/reports', 'report1.json'),
                { task: 'test' },
                { spaces: 2 }
            );
        });
    });
});
