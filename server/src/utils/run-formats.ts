import logger from '../logger';
import { Page } from 'playwright-core';
import {
  convertPageToMarkdown,
  convertPageToHTML,
  convertPageToLinks,
  convertPageToScreenshot,
  convertPageToText,
  isProxyConnectionError,
} from '../markdownify/scrape';

export interface FormatRunResult {
  serializableOutput: Record<string, any>;
  binaryOutput: Record<string, any>;
  markdown: string;
  html: string;
  /** per-format error messages, keyed by format name */
  errors: Record<string, string>;
  /** true when every requested format produced no output */
  allFailed: boolean;
}

const SCRAPE_TIMEOUT = 120000;

function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, r) => setTimeout(() => r(new Error(`${label} timed out after ${SCRAPE_TIMEOUT / 1000}s`)), SCRAPE_TIMEOUT)),
  ]);
}

/**
 * Execute the requested output formats for a page, collecting per-format
 * results and errors instead of silently swallowing them.
 *
 * strict === true: throw when every requested format produced nothing (the
 * caller marks the run failed). strict === false: log + record errors, return
 * whatever succeeded (legacy behaviour).
 *
 * On a proxy connection error (ERR_TUNNEL_CONNECTION_FAILED etc.) the caller
 * may pass `retryWithoutProxy`, which relaunches the page against a fresh
 * no-proxy context and retries once.
 */
export async function runFormatsForPage(
  url: string,
  page: Page,
  formats: string[],
  opts: {
    strict?: boolean;
    /** returns a fresh page with no proxy, or null if not possible */
    retryWithoutProxy?: () => Promise<Page | null>;
    runId?: string;
  } = {}
): Promise<FormatRunResult> {
  const { strict = false, retryWithoutProxy, runId = '' } = opts;

  const serializableOutput: Record<string, any> = {};
  const binaryOutput: Record<string, any> = {};
  const errors: Record<string, string> = {};
  let markdown = '';
  let html = '';

  let activePage = page;
  let proxyRetried = false;

  const attempt = async (fn: () => Promise<void>, label: string) => {
    try {
      await fn();
    } catch (e: any) {
      const msg = e?.message || String(e);
      // One no-proxy retry for proxy-level connection failures.
      if (!proxyRetried && retryWithoutProxy && isProxyConnectionError(msg)) {
        proxyRetried = true;
        logger.log('warn', `[runFormats] ${label} hit proxy error (${msg}); retrying without proxy for run ${runId}`);
        try {
          const fresh = await retryWithoutProxy();
          if (fresh) {
            activePage = fresh;
            await fn(); // retry once on the no-proxy page
            return;
          }
        } catch (e2: any) {
          errors[label] = e2?.message || String(e2);
          logger.log('error', `[runFormats] ${label} failed even without proxy for run ${runId}: ${errors[label]}`);
          return;
        }
      }
      errors[label] = msg;
      logger.log('warn', `[runFormats] ${label} failed for run ${runId}: ${msg}`);
    }
  };

  if (formats.includes('screenshot-visible')) {
    await attempt(async () => {
      const buf = await withTimeout(convertPageToScreenshot(url, activePage, false), 'screenshot-visible');
      binaryOutput['screenshot-visible'] = { data: buf.toString('base64'), mimeType: 'image/png' };
    }, 'screenshot-visible');
  }

  if (formats.includes('screenshot-fullpage')) {
    await attempt(async () => {
      const buf = await withTimeout(convertPageToScreenshot(url, activePage, true), 'screenshot-fullpage');
      binaryOutput['screenshot-fullpage'] = { data: buf.toString('base64'), mimeType: 'image/png' };
    }, 'screenshot-fullpage');
  }

  if (formats.includes('text')) {
    await attempt(async () => {
      const text = await withTimeout(convertPageToText(url, activePage), 'text');
      if (text) serializableOutput.text = [{ content: text }];
      else throw new Error('text conversion returned empty content');
    }, 'text');
  }

  if (formats.includes('markdown')) {
    await attempt(async () => {
      markdown = await withTimeout(convertPageToMarkdown(url, activePage), 'markdown');
      if (markdown && markdown.trim().length > 0) {
        serializableOutput.markdown = [{ content: markdown }];
      } else {
        throw new Error('markdown conversion returned empty content');
      }
    }, 'markdown');
  }

  if (formats.includes('html')) {
    await attempt(async () => {
      html = await withTimeout(convertPageToHTML(url, activePage), 'html');
      if (html && html.trim().length > 0) {
        serializableOutput.html = [{ content: html }];
      } else {
        throw new Error('html conversion returned empty content');
      }
    }, 'html');
  }

  if (formats.includes('links')) {
    await attempt(async () => {
      const links = await withTimeout(convertPageToLinks(url, activePage), 'links');
      if (links && links.length > 0) {
        serializableOutput.links = links.map((link: string) => ({ url: link }));
      } else {
        throw new Error('links extraction returned no links');
      }
    }, 'links');
  }

  // "summary" is produced by the caller (needs LLM config) from `markdown`.
  const producedContent =
    Object.keys(serializableOutput).length > 0 || Object.keys(binaryOutput).length > 0;
  const allFailed = !producedContent && formats.length > 0;

  if (strict && allFailed) {
    const detail = Object.entries(errors).map(([k, v]) => `${k}: ${v}`).join('; ') || 'no output produced';
    throw new Error(`All requested formats failed (${formats.join(', ')}). ${detail}`);
  }

  return { serializableOutput, binaryOutput, markdown, html, errors, allFailed };
}
