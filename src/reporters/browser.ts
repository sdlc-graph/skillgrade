import * as http from 'http';
import * as fs from 'fs-extra';
import * as path from 'path';
import { getReportStore } from '../core/storage';

export async function runBrowserPreview(resultsDir: string, port: number = 3847) {
    const resolved = resultsDir.startsWith('gs://') ? resultsDir : path.resolve(resultsDir);
    const htmlPath = path.join(__dirname, '..', 'viewer.html');

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url || '/', `http://localhost:${port}`);
        const store = getReportStore(resolved);

        if (url.pathname === '/api/reports') {
            const reports = await store.listReports();
            // Sort by timestamp desc
            reports.sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(reports));
        } else if (url.pathname === '/api/report') {
            const file = url.searchParams.get('file');
            if (!file) { res.writeHead(400); res.end('Missing file param'); return; }

            if (req.method === 'DELETE') {
                try {
                    await store.deleteReport(file);
                    res.writeHead(204);
                    res.end();
                } catch {
                    res.writeHead(404);
                    res.end('Not found');
                }
                return;
            }

            try {
                const report = await store.getReport(file);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(report));
            } catch {
                res.writeHead(404);
                res.end('Not found');
            }
        } else {
            const html = await fs.readFile(htmlPath, 'utf-8');
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(html);
        }
    });

    server.listen(port, () => {
        const addr = server.address() as any;
        const actualPort = typeof addr === 'object' ? addr.port : port;
        console.log(`\nskillgrade preview`);
        console.log(`\n  url       http://localhost:${actualPort}`);
        console.log(`  results   ${resolved}\n`);
    });
}
