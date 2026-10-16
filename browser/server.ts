import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import http from 'http';
import net from 'net';
import type { BrowserServer } from 'playwright';

// Apply stealth plugin to chromium
chromium.use(stealthPlugin());

let browserServer: BrowserServer | null = null;

// Configurable ports with defaults
const BROWSER_WS_PORT = parseInt(process.env.BROWSER_WS_PORT || '3001', 10);
const BROWSER_HEALTH_PORT = parseInt(process.env.BROWSER_HEALTH_PORT || '3002', 10);
const BROWSER_WS_HOST = process.env.BROWSER_WS_HOST || 'localhost';
// On Render only ONE port is publicly routed. SINGLE_PORT=true makes the public
// HTTP server answer /health AND tunnel WebSocket upgrades to the internal
// Playwright WS port, so a single exposed port serves both.
const SINGLE_PORT = process.env.BROWSER_SINGLE_PORT === 'true';

async function start(): Promise<void> {
    console.log('Starting Maxun Browser Service...');
    console.log(`WebSocket port: ${BROWSER_WS_PORT}`);
    console.log(`Health check port: ${BROWSER_HEALTH_PORT}`);

    try {
        // Launch browser server that exposes WebSocket endpoint
        browserServer = await chromium.launchServer({
            headless: true,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-site-isolation-trials',
                '--disable-extensions',
                '--no-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--force-color-profile=srgb',
                '--force-device-scale-factor=2',
                '--ignore-certificate-errors',
                '--mute-audio'
            ],
            port: BROWSER_WS_PORT,
        });

        console.log(`✅ Browser WebSocket endpoint ready: ${browserServer.wsEndpoint()}`);
        console.log(`✅ Stealth plugin enabled`);

        // Health check HTTP server
        const healthServer = http.createServer((req, res) => {
            if (req.url === '/health') {
                const raw = browserServer?.wsEndpoint() || '';
            const wsEndpoint = raw.replace(/ws\:\/\/(localhost|0\.0\.0\.0|127\.0\.0\.1)/, `ws://${BROWSER_WS_HOST}`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: 'healthy',
                    wsEndpoint,
                    wsPort: BROWSER_WS_PORT,
                    healthPort: BROWSER_HEALTH_PORT,
                    timestamp: new Date().toISOString()
                }));
            } else if (req.url === '/') {
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                const raw = browserServer?.wsEndpoint() || '';
            const wsEndpoint = raw.replace(/ws\:\/\/(localhost|0\.0\.0\.0|127\.0\.0\.1)/, `ws://${BROWSER_WS_HOST}`);
                res.end(`Maxun Browser Service\nWebSocket: ${wsEndpoint}\nHealth: http://localhost:${BROWSER_HEALTH_PORT}/health`);
            } else {
                res.writeHead(404);
                res.end('Not Found');
            }
        });

        if (SINGLE_PORT) {
            // Tunnel WS upgrades on the public (health) port to the internal Playwright WS port.
            healthServer.on('upgrade', (req, socket, head) => {
                const upstream = net.connect(BROWSER_WS_PORT, '127.0.0.1', () => {
                    const reqLine = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
                    const headers = Object.entries(req.headers).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\r\n');
                    upstream.write(reqLine + headers + '\r\n\r\n');
                    if (head && head.length) upstream.write(head);
                    upstream.pipe(socket as net.Socket);
                    (socket as net.Socket).pipe(upstream);
                });
                upstream.on('error', (e) => { console.error('WS tunnel upstream error:', e.message); (socket as net.Socket).destroy(); });
                (socket as net.Socket).on('error', () => upstream.destroy());
            });
        }

        healthServer.listen(BROWSER_HEALTH_PORT, () => {
            console.log(`✅ Health check server running on port ${BROWSER_HEALTH_PORT}`);
            console.log('Browser service is ready to accept connections!');
        });
    } catch (error) {
        console.error('❌ Failed to start browser service:', error);
        process.exit(1);
    }
}

// Graceful shutdown
async function shutdown(): Promise<void> {
    console.log('Shutting down browser service...');
    if (browserServer) {
        try {
            await browserServer.close();
            console.log('Browser server closed');
        } catch (error) {
            console.error('Error closing browser server:', error);
        }
    }
    process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start the service
start().catch(console.error);
