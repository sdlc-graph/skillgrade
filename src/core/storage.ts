import * as fs from 'fs-extra';
import * as path from 'path';
import { Storage } from '@google-cloud/storage';
import { parseGcsUri } from '../utils/gcs';
import { EvalReport } from '../types';

export interface ReportStore {
    listReports(): Promise<EvalReport[]>;
    getReport(filename: string): Promise<EvalReport>;
    saveReport(filename: string, report: EvalReport): Promise<void>;
    deleteReport(filename: string): Promise<void>;
}

export class LocalReportStore implements ReportStore {
    constructor(private dir: string) {}

    async listReports(): Promise<EvalReport[]> {
        const files = (await fs.readdir(this.dir)).filter(f => f.endsWith('.json'));
        const reports: EvalReport[] = [];
        for (const file of files) {
            try {
                const report = await fs.readJSON(path.join(this.dir, file));
                reports.push({ file, ...report } as any);
            } catch {}
        }
        return reports;
    }

    async getReport(filename: string): Promise<EvalReport> {
        return await fs.readJSON(path.join(this.dir, filename));
    }

    async saveReport(filename: string, report: EvalReport): Promise<void> {
        await fs.ensureDir(this.dir);
        await fs.writeJSON(path.join(this.dir, filename), report, { spaces: 2 });
    }

    async deleteReport(filename: string): Promise<void> {
        await fs.remove(path.join(this.dir, filename));
    }
}

export class GcsReportStore implements ReportStore {
    private bucket: string;
    private prefix: string;
    private storage: Storage;

    constructor(uri: string) {
        const parsed = parseGcsUri(uri);
        this.bucket = parsed.bucket;
        this.prefix = parsed.prefix.endsWith('/') ? parsed.prefix : parsed.prefix + '/';
        this.storage = new Storage();
    }

    async listReports(): Promise<EvalReport[]> {
        const bucketObj = this.storage.bucket(this.bucket);
        const [files] = await bucketObj.getFiles({ prefix: this.prefix });
        const reports: EvalReport[] = [];
        for (const file of files) {
            if (!file.name.endsWith('.json')) continue;
            try {
                const [content] = await file.download();
                const report = JSON.parse(content.toString());
                reports.push({ file: path.basename(file.name), ...report } as any);
            } catch {}
        }
        return reports;
    }

    async getReport(filename: string): Promise<EvalReport> {
        const bucketObj = this.storage.bucket(this.bucket);
        const fileObj = bucketObj.file(path.join(this.prefix, filename));
        const [content] = await fileObj.download();
        return JSON.parse(content.toString());
    }

    async saveReport(filename: string, report: EvalReport): Promise<void> {
        const bucketObj = this.storage.bucket(this.bucket);
        const fileObj = bucketObj.file(path.join(this.prefix, filename));
        await fileObj.save(JSON.stringify(report, null, 2), {
            contentType: 'application/json'
        });
    }

    async deleteReport(filename: string): Promise<void> {
        const bucketObj = this.storage.bucket(this.bucket);
        const fileObj = bucketObj.file(path.join(this.prefix, filename));
        await fileObj.delete();
    }
}

export function getReportStore(uri: string): ReportStore {
    if (uri.startsWith('gs://')) {
        return new GcsReportStore(uri);
    }
    return new LocalReportStore(uri);
}
