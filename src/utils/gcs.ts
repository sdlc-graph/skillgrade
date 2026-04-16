import { Storage } from '@google-cloud/storage';

export interface GcsPath {
    bucket: string;
    prefix: string;
}

export function parseGcsUri(uri: string): GcsPath {
    const url = new URL(uri);
    return {
        bucket: url.host,
        prefix: url.pathname.startsWith('/') ? url.pathname.substring(1) : url.pathname
    };
}

export async function uploadToGcs(uri: string, data: string | object): Promise<void> {
    const { bucket, prefix } = parseGcsUri(uri);
    const storage = new Storage();
    const bucketObj = storage.bucket(bucket);
    const fileObj = bucketObj.file(prefix);
    await fileObj.save(typeof data === 'string' ? data : JSON.stringify(data, null, 2), {
        contentType: 'application/json'
    });
}
