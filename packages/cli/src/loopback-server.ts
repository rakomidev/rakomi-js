// SPDX-License-Identifier: MIT

import { createServer, type Server } from 'node:http';

import { CliError, EXIT } from './errors.js';

export interface LoopbackResult {
  readonly code?: string;
  readonly state?: string;
  readonly error?: string;
  readonly errorDescription?: string;
}

export interface LoopbackListener {
  /** `http://127.0.0.1:<port>/callback` — pass this as the OAuth `redirect_uri`. */
  readonly redirectUri: string;
  /** Resolves with the callback's query params on the FIRST request, or rejects on timeout/server error. */
  waitForCallback(timeoutMs: number): Promise<LoopbackResult>;
  close(): void;
}

const SUCCESS_PAGE = `<!doctype html><html><head><title>rakomi login</title></head>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;text-align:center">
<h1>Signed in</h1><p>You can close this tab and return to your terminal.</p></body></html>`;

const ERROR_PAGE = (message: string): string =>
  `<!doctype html><html><head><title>rakomi login</title></head>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;text-align:center">
<h1>Sign-in failed</h1><p>${escapeHtml(message)}</p><p>Return to your terminal and try again.</p></body></html>`;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Start the loopback listener. Binds port 0 (OS-assigned ephemeral port) on 127.0.0.1 ONLY.
 * `waitForCallback` resolves the FIRST `/callback` request it sees; any other path gets a plain
 * 404 and does NOT resolve the promise (so a stray browser prefetch / favicon request can't steal
 * the one-shot callback).
 */
export async function startLoopbackListener(): Promise<LoopbackListener> {
  let resolveCallback: ((r: LoopbackResult) => void) | undefined;
  let rejectCallback: ((e: Error) => void) | undefined;
  let settled = false;

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    const code = url.searchParams.get('code') ?? undefined;
    const state = url.searchParams.get('state') ?? undefined;
    const error = url.searchParams.get('error') ?? undefined;
    const errorDescription = url.searchParams.get('error_description') ?? undefined;

    res.writeHead(error ? 400 : 200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(error ? ERROR_PAGE(errorDescription ?? error) : SUCCESS_PAGE);

    if (!settled) {
      settled = true;
      resolveCallback?.({ code, state, error, errorDescription });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new CliError('Could not start the local sign-in listener.', EXIT.FAIL);
  }
  const redirectUri = `http://127.0.0.1:${address.port}/callback`;

  return {
    redirectUri,
    waitForCallback(timeoutMs: number): Promise<LoopbackResult> {
      return new Promise<LoopbackResult>((resolve, reject) => {
        resolveCallback = resolve;
        rejectCallback = reject;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new CliError('Timed out waiting for the browser sign-in to complete.', EXIT.FAIL));
          }
        }, timeoutMs);
        timer.unref?.();
      });
    },
    close(): void {
      rejectCallback?.(new CliError('The local sign-in listener was closed before a callback arrived.', EXIT.FAIL));
      server.close();
    },
  };
}
