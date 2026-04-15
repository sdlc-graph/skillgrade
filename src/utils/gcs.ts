import { Storage } from '@google-cloud/storage';

export interface GcsPath {
    bucket: string;
    prefix: string;
}

export function parseGcsUri(uri: string): GcsPath {
    const withoutProtocol = uri.substring(5); // remove gs://
    const firstSlash = withoutProtocol.indexOf('/');
    if (firstSlash === -1) {
        return { bucket: withoutProtocol, prefix: '' };
    }
    return {
        bucket: withoutProtocol.substring(0, firstSlash),
        prefix: withoutProtocol.substring(firstSlash + 1)
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
