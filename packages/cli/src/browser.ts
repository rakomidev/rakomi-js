// SPDX-License-Identifier: MIT

import { execFile } from 'node:child_process';

export type BrowserOpener = (url: string) => Promise<void>;

/** Real opener: `open` (macOS), `xdg-open` (Linux), `start` via cmd (Windows). */
export function systemBrowserOpener(platform: NodeJS.Platform = process.platform): BrowserOpener {
  return (url: string) =>
    new Promise<void>((resolve) => {
      const done = () => resolve();
      if (platform === 'darwin') {
        execFile('open', [url], done);
      } else if (platform === 'win32') {
        execFile('cmd', ['/c', 'start', '""', url], done);
      } else {
        execFile('xdg-open', [url], done);
      }
    });
}
