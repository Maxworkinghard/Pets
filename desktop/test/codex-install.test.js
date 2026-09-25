import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXPORT_MARKER, installCodexPet, isPetsExport, listExports } from '../src/main/codex-install.js';

// 一个最小的「看起来像 WebP」的数据：RIFF....WEBP
const webp = (tag = 'A') => new Uint8Array(Buffer.from(`RIFF\x00\x00\x00\x00WEBPVP8L${tag.repeat(16)}`, 'latin1'));
const tmpPets = () => fs.mkdtempSync(path.join(os.tmpdir(), 'codex-pets-'));
const pet = { id: 'cat', name: '小猫', description: '一只猫' };

test('装进 Codex：写入 pet.json、spritesheet.webp 和导出标记', () => {
  const petsDir = tmpPets();
  const res = installCodexPet({ petsDir, sourceKey: 'bundled/cat', pet, bytes: webp() });
  assert.deepEqual([res.ok, res.folder, res.avatarId], [true, 'cat', 'custom:cat']);
  const manifest = JSON.parse(fs.readFileSync(path.join(petsDir, 'cat', 'pet.json'), 'utf8'));
  assert.deepEqual(manifest, { id: 'cat', displayName: '小猫', description: '一只猫', spritesheetPath: 'spritesheet.webp' });
  assert.ok(isPetsExport(path.join(petsDir, 'cat')));
  assert.deepEqual(listExports(petsDir).get('bundled/cat').folder, 'cat');
  assert.deepEqual(fs.readdirSync(petsDir), ['cat']); // 临时文件夹已清理
});

test('再次导入会原地更新自己导出的版本', () => {
  const petsDir = tmpPets();
  installCodexPet({ petsDir, sourceKey: 'bundled/cat', pet, bytes: webp('A') });
  const res = installCodexPet({ petsDir, sourceKey: 'bundled/cat', pet, bytes: webp('B') });
  assert.equal(res.folder, 'cat');
  assert.ok(fs.readFileSync(path.join(petsDir, 'cat', 'spritesheet.webp'), 'latin1').includes('BBBB'));
  assert.deepEqual(fs.readdirSync(petsDir), ['cat']);
});

test('不会覆盖同名的、不是 Pets 导出的 Codex 宠物', () => {
  const petsDir = tmpPets();
  fs.mkdirSync(path.join(petsDir, 'cat'));
  fs.writeFileSync(path.join(petsDir, 'cat', 'pet.json'), '{"id":"cat"}');
  const res = installCodexPet({ petsDir, sourceKey: 'bundled/cat', pet, bytes: webp() });
  assert.equal(res.folder, 'cat-2');
  assert.equal(fs.readFileSync(path.join(petsDir, 'cat', 'pet.json'), 'utf8'), '{"id":"cat"}');
  assert.ok(!fs.existsSync(path.join(petsDir, 'cat', EXPORT_MARKER)));
});

test('拒绝不是 WebP 的数据', () => {
  const res = installCodexPet({ petsDir: tmpPets(), sourceKey: 'k', pet, bytes: new Uint8Array([1, 2, 3]) });
  assert.equal(res.ok, false);
});
