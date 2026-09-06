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

const PAGE_STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: "Inter", ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";
    background: linear-gradient(to bottom, #F3F4F7, #ECEEF2, #E4E6EB);
    color: #2A2A2A;
  }
  .card {
    max-width: 26rem;
    width: calc(100% - 3rem);
    margin: 1.5rem;
    padding: 2.5rem 2rem;
    border-radius: 1rem;
    text-align: center;
    background: rgba(255, 255, 255, 0.75);
    border: 1px solid rgba(29, 85, 102, 0.14);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08), 0 8px 24px rgba(29, 85, 102, 0.08);
  }
  .wordmark {
    font-size: 0.8125rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #1d5566;
    margin: 0 0 1.5rem;
  }
  .icon {
    width: 3rem;
    height: 3rem;
    margin: 0 auto 1.25rem;
    border-radius: 999px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1.5rem;
    line-height: 1;
  }
  .icon.success { background: rgba(40, 114, 77, 0.14); color: #28724D; }
  .icon.error { background: rgba(189, 46, 46, 0.14); color: #BD2E2E; }
  h1 {
    font-size: 1.25rem;
    font-weight: 700;
    line-height: 1.25;
    margin: 0 0 0.5rem;
    color: #2A2A2A;
  }
  p {
    font-size: 0.9375rem;
    line-height: 1.5;
    color: #4A4A4A;
    margin: 0 0 0.375rem;
  }
  p.hint { color: #616161; font-size: 0.875rem; }
  @media (prefers-color-scheme: dark) {
    body { background: linear-gradient(to bottom right, #23242c, #1e1f26, #191a20); color: #e6e7ec; }
    .card { background: rgba(255, 255, 255, 0.07); border-color: rgba(255, 255, 255, 0.10); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3); }
    .wordmark { color: #51b0cd; }
    .icon.success { background: rgba(98, 200, 146, 0.16); color: #62C892; }
    .icon.error { background: rgba(242, 159, 159, 0.16); color: #F29F9F; }
    h1 { color: #e6e7ec; }
    p { color: #a1a3ad; }
    p.hint { color: #a1a3ad; }
  }
`;

const SUCCESS_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>rakomi login</title><style>${PAGE_STYLE}</style></head>
<body><main class="card">
<p class="wordmark">rakomi</p>
<div class="icon success" aria-hidden="true">&#10003;</div>
<h1>Signed in</h1>
<p>You can close this tab and return to your terminal.</p>
</main></body></html>`;

const ERROR_PAGE = (message: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>rakomi login</title><style>${PAGE_STYLE}</style></head>
<body><main class="card">
<p class="wordmark">rakomi</p>
<div class="icon error" aria-hidden="true">&#10005;</div>
<h1>Sign-in failed</h1>
<p>${escapeHtml(message)}</p>
<p class="hint">Return to your terminal and try again.</p>
</main></body></html>`;

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
