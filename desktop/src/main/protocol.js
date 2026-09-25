// pets:// 自定义协议：界面页面与宠物素材同源提供（ES 模块、canvas 读像素都不受跨域限制）。
//   pets://app/renderer/...、pets://app/shared/...   → desktop/src 下的界面代码
//   pets://app/assets/<来源>/<目录名>/<相对路径>      → 对应宠物目录里的素材
import fs from 'node:fs';
import path from 'node:path';
import { protocol } from 'electron';
import { resolveInside } from './registry.js';

export const SCHEME = 'pets';
export const ORIGIN = `${SCHEME}://app`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.apng': 'image/apng',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

/** 必须在 app ready 之前调用。 */
export function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
  ]);
}

export function assetBase(record) {
  return `${ORIGIN}/assets/${encodeURIComponent(record.source)}/${encodeURIComponent(record.dirName)}/`;
}

/**
 * @param {string} srcRoot desktop/src
 * @param {(key: string) => {dir: string} | undefined} findRecord
 */
export function handleProtocol(srcRoot, findRecord) {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    let file = null;
    if (url.host === 'app' && parts[0] === 'assets' && parts.length >= 4) {
      const record = findRecord(`${parts[1]}/${parts[2]}`);
      if (record) file = resolveInside(record.dir, parts.slice(3).join('/'));
    } else if (url.host === 'app' && (parts[0] === 'renderer' || parts[0] === 'shared')) {
      file = resolveInside(srcRoot, parts.join('/'));
    }
    if (!file) return new Response('Not found', { status: 404 });
    try {
      const data = await fs.promises.readFile(file);
      const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
      return new Response(data, { headers: { 'content-type': type, 'cache-control': 'no-cache' } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}
