// 宠物仓库扫描：读取各来源目录下的 <宠物>/pet.json，规范化并校验。
// 不依赖 Electron，校验脚本（scripts/validate-pets.js）也用它。
import fs from 'node:fs';
import path from 'node:path';
import { normalizeManifest } from '../shared/manifest.js';

/**
 * 按「精确大小写」检查 rel 是否是 dir 内的文件。
 * Windows 文件系统不区分大小写，但 GitHub / Linux / macOS 区分，这里统一按严格规则校验。
 */
export function fileExistsExact(dir, rel, cache = new Map()) {
  let cur = dir;
  const parts = rel.split('/');
  for (let i = 0; i < parts.length; i++) {
    let names = cache.get(cur);
    if (!names) {
      try {
        names = new Map(fs.readdirSync(cur, { withFileTypes: true }).map((d) => [d.name, d]));
      } catch {
        return false;
      }
      cache.set(cur, names);
    }
    const entry = names.get(parts[i]);
    if (!entry) return false;
    const isLast = i === parts.length - 1;
    if (isLast ? !entry.isFile() : !entry.isDirectory()) return false;
    cur = path.join(cur, parts[i]);
  }
  return true;
}

/** 解析宠物目录内的相对路径；越界或不存在时返回 null。 */
export function resolveInside(root, rel) {
  const abs = path.resolve(root, rel);
  const r = path.relative(root, abs);
  if (!r || r.startsWith('..') || path.isAbsolute(r)) return null;
  return abs;
}

/** 读取一个宠物目录。返回记录（pet 为 null 表示无效，原因见 errors）。 */
export function loadPet(source, petDir) {
  const dirName = path.basename(petDir);
  const record = { key: `${source}/${dirName}`, source, dirName, dir: petDir, pet: null, errors: [], warnings: [] };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(petDir, 'pet.json'), 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    record.errors.push(`pet.json 无法读取或不是合法 JSON：${e.message}`);
    return record;
  }
  const cache = new Map();
  const res = normalizeManifest(raw, { dirName, fileExists: (rel) => fileExistsExact(petDir, rel, cache) });
  return { ...record, ...res };
}

/** 扫描一个来源目录：每个含 pet.json 的子目录是一只宠物。 */
export function scanSource(source, dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const records = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const petDir = path.join(dir, entry.name);
    if (fs.existsSync(path.join(petDir, 'pet.json'))) records.push(loadPet(source, petDir));
  }
  return records.sort((a, b) => (a.pet?.name ?? a.dirName).localeCompare(b.pet?.name ?? b.dirName, 'zh-CN'));
}

/** @param {{id: string, dir: string}[]} sources */
export function scanAll(sources) {
  return sources.flatMap((s) => scanSource(s.id, s.dir));
}
