// 把导出的 Codex 宠物装进 Codex 的宠物目录（${CODEX_HOME:-~/.codex}/pets/<文件夹>/）。
// 不依赖 Electron，方便单元测试。Codex 通过 `custom:<文件夹名>` 引用自定义宠物。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const EXPORT_MARKER = '.pets-export.json';
const MAX_BYTES = 30 * 1024 * 1024;

export function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

export function codexPetsDir() {
  return path.join(codexHome(), 'pets');
}

/** 目录是不是由 Pets 导出的（带标记文件）。 */
export function isPetsExport(dir) {
  return fs.existsSync(path.join(dir, EXPORT_MARKER));
}

/** 已导出到 Codex 的宠物：来源 key → { folder, exportedAt }。 */
export function listExports(petsDir = codexPetsDir()) {
  const out = new Map();
  if (!fs.existsSync(petsDir)) return out;
  for (const d of fs.readdirSync(petsDir, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue;
    try {
      const marker = JSON.parse(fs.readFileSync(path.join(petsDir, d.name, EXPORT_MARKER), 'utf8'));
      if (typeof marker.sourceKey === 'string') out.set(marker.sourceKey, { folder: d.name, exportedAt: marker.exportedAt });
    } catch {
      // 不是我们导出的
    }
  }
  return out;
}

const isWebp = (b) =>
  b.length > 16 && String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP';

/**
 * 写入（或更新）一只 Codex 宠物。只会覆盖 Pets 自己导出过的文件夹；
 * 同名但不是我们导出的文件夹会被保留，改用 <id>-2、<id>-3…
 * @returns {{ok: true, folder: string, dir: string, avatarId: string} | {ok: false, error: string}}
 */
export function installCodexPet({ petsDir = codexPetsDir(), sourceKey, pet, bytes }) {
  if (!(bytes instanceof Uint8Array) || !isWebp(bytes) || bytes.length > MAX_BYTES) {
    return { ok: false, error: '精灵图数据无效' };
  }
  fs.mkdirSync(petsDir, { recursive: true });
  let folder = listExports(petsDir).get(sourceKey)?.folder;
  if (!folder) {
    folder = pet.id;
    for (let i = 2; fs.existsSync(path.join(petsDir, folder)); i++) folder = `${pet.id}-${i}`;
  }
  const dest = path.join(petsDir, folder);
  // 先写到临时文件夹（pet.json 最后写），再整体改名，Codex 不会读到写了一半的宠物
  const tmp = path.join(petsDir, `.${folder}.tmp-${process.pid}-${Date.now()}`);
  fs.mkdirSync(tmp);
  try {
    fs.writeFileSync(path.join(tmp, 'spritesheet.webp'), bytes);
    const marker = { exportedBy: 'Pets', sourceKey, sourceId: pet.id, exportedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(tmp, EXPORT_MARKER), JSON.stringify(marker, null, 2));
    const manifest = { id: folder, displayName: pet.name, description: pet.description || pet.name, spritesheetPath: 'spritesheet.webp' };
    fs.writeFileSync(path.join(tmp, 'pet.json'), JSON.stringify(manifest, null, 2));
    if (fs.existsSync(dest)) {
      if (!isPetsExport(dest)) throw new Error(`目标文件夹不是 Pets 导出的：${dest}`);
      fs.rmSync(dest, { recursive: true, force: true });
    }
    fs.renameSync(tmp, dest);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return { ok: false, error: e.message };
  }
  return { ok: true, folder, dir: dest, avatarId: `custom:${folder}` };
}
