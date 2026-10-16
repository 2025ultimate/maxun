import { chromium } from 'playwright-core';
import type { Browser } from 'playwright-core';
import logger from '../logger';

/**
 * Configuration for connection retry logic
 */
const CONNECTION_CONFIG = {
    maxRetries: 3,
    retryDelay: 2000,
    connectionTimeout: 30000,
};

// On Render (and other public-edge hosts) the browser service sits behind an
// HTTPS/WSS edge on 443. BROWSER_WS_SECURE=true switches health+ws to https/wss
// and drops the explicit port. Default (unset) keeps the docker-compose http
// behaviour used on the VPS.
function browserServiceBase(): { httpUrl: string; secure: boolean; host: string } {
    const host = process.env.BROWSER_WS_HOST || 'localhost';
    const secure = (process.env.BROWSER_WS_SECURE === 'true') || host.endsWith('.onrender.com');
    const port = process.env.BROWSER_HEALTH_PORT || '3002';
    const httpUrl = secure ? `https://${host}` : `http://${host}:${port}`;
    return { httpUrl, secure, host };
}

// Rewrite a ws:// endpoint (which may carry localhost/0.0.0.0/an internal port)
// to the reachable public one: wss://<host> on 443 when secure, else ws://<host>:<wsPort>.
function toReachableWsEndpoint(raw: string): string {
    const host = process.env.BROWSER_WS_HOST || 'localhost';
    const secure = (process.env.BROWSER_WS_SECURE === 'true') || host.endsWith('.onrender.com');
    // keep any path/query (the browser id segment) from the raw endpoint
    let tail = '';
    try {
        const m = raw.match(/^[a-z]+:\/\/[^/]+(\/.*)?$/i);
        if (m && m[1]) tail = m[1];
    } catch (_) {}
    if (secure) return `wss://${host}${tail}`;
    const wsPort = process.env.BROWSER_WS_PORT || '3001';
    return `ws://${host}:${wsPort}${tail}`;
}

/**
 * Get the WebSocket endpoint from the browser service health check
 * @returns Promise<string> - The WebSocket endpoint URL with browser ID
 */
async function getBrowserServiceEndpoint(): Promise<string> {
    const { httpUrl } = browserServiceBase();
    const healthEndpoint = `${httpUrl}/health`;

    try {
        logger.debug(`Fetching WebSocket endpoint from: ${healthEndpoint}`);
        const response = await fetch(healthEndpoint);
        const data = await response.json();

        if (data.status === 'healthy' && data.wsEndpoint) {
            const reachable = toReachableWsEndpoint(data.wsEndpoint);
            logger.debug(`Got WebSocket endpoint: ${data.wsEndpoint} -> ${reachable}`);
            return reachable;
        }

        throw new Error('Health check did not return a valid wsEndpoint');
    } catch (error: any) {
        logger.error(`Failed to fetch endpoint from health check: ${error.message}`);
        throw new Error(
            `Browser service is not accessible at ${healthEndpoint}. ` +
            `Make sure the browser service is running (docker-compose up browser)`
        );
    }
}

/**
 * Launch a local browser as fallback when browser service is unavailable
 * @returns Promise<Browser> - Locally launched browser instance
 */
async function launchLocalBrowser(): Promise<Browser> {
    logger.warn('Attempting to launch local browser');
    logger.warn('Note: This requires Chromium binaries to be installed (npx playwright install chromium)');

    try {
        const browser = await chromium.launch({
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
        });

        logger.info('Successfully launched local browser');
        return browser;
    } catch (error: any) {
        logger.error(`Failed to launch local browser: ${error.message}`);
        throw new Error(
            `Could not launch local browser. ` +
            `Please either:\n` +
            `  1. Start the browser service: docker-compose up browser\n` +
            `  2. Install Chromium binaries: npx playwright@1.57.0 install chromium`
        );
    }
}

/**
 * Connect to the remote browser service with retry logic, with fallback to local browser
 * @param retries - Number of connection attempts (default: 3)
 * @returns Promise<Browser> - Connected browser instance (remote or local)
 * @throws Error if both remote connection and local launch fail
 */
export async function connectToRemoteBrowser(retries?: number): Promise<Browser> {
    const maxRetries = retries ?? CONNECTION_CONFIG.maxRetries;

    try {
        // Public-edge (Render) mode: the health JSON endpoint isn't reachable on the
        // routed port; connect directly to the WS edge instead.
        const host0 = process.env.BROWSER_WS_HOST || 'localhost';
        const directWs = (process.env.BROWSER_WS_DIRECT === 'true') || host0.endsWith('.onrender.com');
        let wsEndpoint: string;
        if (directWs) {
            wsEndpoint = `wss://${host0}`;
            logger.info(`Direct WS connect (no health fetch) to ${wsEndpoint}`);
        } else {
            wsEndpoint = await getBrowserServiceEndpoint();
        }
        logger.info(`Connecting to browser service at ${wsEndpoint}...`);

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                logger.debug(`Connection attempt ${attempt}/${maxRetries}`);

                const browser = await chromium.connect(wsEndpoint, {
                    timeout: CONNECTION_CONFIG.connectionTimeout,
                });

                logger.info('Successfully connected to browser service');
                return browser;
            } catch (error: any) {
                logger.warn(
                    `Connection attempt ${attempt}/${maxRetries} failed: ${error.message}`
                );

                if (attempt === maxRetries) {
                    logger.error(
                        `Failed to connect to browser service after ${maxRetries} attempts`
                    );
                    throw new Error(`Remote connection failed: ${error.message}`);
                }

                logger.debug(`Waiting ${CONNECTION_CONFIG.retryDelay}ms before retry...`);
                await new Promise(resolve => setTimeout(resolve, CONNECTION_CONFIG.retryDelay));
            }
        }

        throw new Error('Failed to connect to browser service');
    } catch (error: any) {
        logger.warn(`Browser service connection failed: ${error.message}`);
        logger.warn('Falling back to local browser launch...');

        return await launchLocalBrowser();
    }
}

/**
 * Check if browser service is healthy
 * @returns Promise<boolean> - true if service is healthy
 */
export async function checkBrowserServiceHealth(): Promise<boolean> {
    try {
        const { httpUrl } = browserServiceBase();
        const healthEndpoint = `${httpUrl}/health`;

        const response = await fetch(healthEndpoint);
        const data = await response.json();

        if (data.status === 'healthy') {
            logger.info('Browser service health check passed');
            return true;
        }

        logger.warn('Browser service health check failed:', data);
        return false;
    } catch (error: any) {
        logger.error('Browser service health check error:', error.message);
        return false;
    }
}
