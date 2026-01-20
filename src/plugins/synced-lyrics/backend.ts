import { net } from 'electron';

import { createBackend } from '@/utils';

const handlers = {
  // Note: This will only be used for Forbidden headers, e.g. User-Agent, Authority, Cookie, etc.
  // See: https://developer.mozilla.org/en-US/docs/Glossary/Forbidden_request_header
  async fetch(
    url: string,
    init: RequestInit,
  ): Promise<[number, string, Record<string, string>]> {
    const res = await net.fetch(url, init);
    return [
      res.status,
      await res.text(),
      Object.fromEntries(res.headers.entries()),
    ];
  },
};

let lastCurrent: { index: number; line: any; timestamp: number } | null = null;


export const backend = createBackend({
  start(ctx) {
    ctx.ipc.handle('synced-lyrics:fetch', (url: string, init: RequestInit) =>
      handlers.fetch(url, init),
    );
    ctx.ipc.on('synced-lyrics:current', (payload: { index: number; line: any; timestamp: number }) => {
      lastCurrent = payload;
    });
    ctx.ipc.handle('synced-lyrics:get-current', () => lastCurrent);
  },
  stop(ctx) {
    ctx.ipc.removeHandler('synced-lyrics:fetch');
  ctx.ipc.removeHandler('synced-lyrics:get-current');
  },
});
