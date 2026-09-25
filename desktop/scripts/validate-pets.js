#!/usr/bin/env node
// 校验宠物仓库（CI 与本地通用）：
//   node scripts/validate-pets.js              校验仓库根目录下的 pets/
//   node scripts/validate-pets.js <目录> ...   校验指定目录（每个子目录是一只宠物）
import fs from 'node:fs';
import path from 'node:path';
import { scanSource } from '../src/main/registry.js';
import { referencedFiles } from '../src/shared/manifest.js';

const REPO_PETS = path.resolve(import.meta.dirname, '..', '..', 'pets');
const MAX_FILE_MB = 5;
const EXTRA_OK = /^(pet\.json|readme(\.md)?|license(\.\w+)?|preview\.(png|gif|webp))$/i;

function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const abs = path.join(dir, d.name);
    return d.isDirectory() ? listFiles(abs, base) : [path.relative(base, abs).split(path.sep).join('/')];
  });
}

const targets = process.argv.length > 2 ? process.argv.slice(2).map((d) => path.resolve(d)) : [REPO_PETS];
const ids = new Map();
let total = 0;
let failed = 0;

for (const dir of targets) {
  if (!fs.existsSync(dir)) {
    console.error(`目录不存在：${dir}`);
    process.exitCode = 1;
    continue;
  }
  for (const r of scanSource('bundled', dir)) {
    total++;
    const errors = [...r.errors];
    const warnings = [...r.warnings];
    if (r.pet) {
      if (r.pet.id !== r.dirName) errors.push(`仓库内的宠物 id 必须与目录名相同（id「${r.pet.id}」，目录「${r.dirName}」）`);
      if (ids.has(r.pet.id)) errors.push(`id「${r.pet.id}」与 ${ids.get(r.pet.id)} 重复`);
      ids.set(r.pet.id, r.dir);
      const used = new Set(referencedFiles(r.pet));
      for (const f of listFiles(r.dir)) {
        const mb = fs.statSync(path.join(r.dir, f)).size / 1024 / 1024;
        if (mb > MAX_FILE_MB) warnings.push(`${f} 有 ${mb.toFixed(1)} MB，建议压缩到 ${MAX_FILE_MB} MB 以内`);
        if (!used.has(f) && !EXTRA_OK.test(f)) warnings.push(`${f} 没有被 pet.json 引用，可以删掉`);
      }
    }
    if (errors.length) {
      failed++;
      console.log(`✖ ${r.dirName}`);
      for (const e of errors) console.log(`    错误：${e}`);
    } else {
      const n = Object.keys(r.pet.animations).length;
      console.log(`✔ ${r.dirName}（${r.pet.name}，${n} 个动画，${r.pet.actions.length} 个动作）`);
    }
    for (const w of warnings) console.log(`    提示：${w}`);
  }
}

if (total === 0) console.log('还没有宠物（宠物包不进 Git，放在本地 pets/ 里即可）。');
else console.log(`\n共 ${total} 只宠物，${total - failed} 只通过，${failed} 只有错误。`);
if (failed) process.exitCode = 1;
