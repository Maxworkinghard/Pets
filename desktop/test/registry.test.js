import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileExistsExact, loadPet, resolveInside, scanSource } from '../src/main/registry.js';

const REPO_PETS = path.resolve(import.meta.dirname, '..', '..', 'pets');

function tmpPet(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pets-test-'));
  const petDir = path.join(dir, 'cat');
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(petDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(petDir, rel), content);
  }
  return { root: dir, petDir };
}

test('本地 pets/ 里的每只宠物都能通过校验（宠物包不进 Git，CI 上可能一只都没有）', () => {
  for (const r of scanSource('bundled', REPO_PETS)) {
    assert.deepEqual(r.errors, [], `${r.dirName}: ${r.errors.join('; ')}`);
    assert.equal(r.pet.id, r.dirName);
  }
});

test('扫描来源目录：只认含 pet.json 的子文件夹，按名字排序', () => {
  const { root } = tmpPet({
    'pet.json': JSON.stringify({ id: 'cat', name: '猫', animations: { idle: { frames: ['a.png'] } } }),
    'a.png': 'x',
  });
  fs.mkdirSync(path.join(root, 'not-a-pet'));
  fs.mkdirSync(path.join(root, '.hidden'));
  const records = scanSource('user', root);
  assert.deepEqual(records.map((r) => [r.key, !!r.pet]), [['user/cat', true]]);
});

test('文件名大小写必须完全一致', () => {
  const { petDir } = tmpPet({ 'frames/Idle.png': 'x' });
  assert.equal(fileExistsExact(petDir, 'frames/Idle.png'), true);
  assert.equal(fileExistsExact(petDir, 'frames/idle.png'), false);
  assert.equal(fileExistsExact(petDir, 'Frames/Idle.png'), false);
  assert.equal(fileExistsExact(petDir, 'frames'), false); // 目录不算文件
});

test('素材缺失、JSON 损坏都会变成错误记录，而不是抛异常', () => {
  const a = tmpPet({ 'pet.json': JSON.stringify({ id: 'cat', name: '猫', animations: { idle: { src: 'idle.gif' } } }) });
  const ra = loadPet('user', a.petDir);
  assert.equal(ra.pet, null);
  assert.ok(ra.errors.some((e) => e.includes('idle.gif')));
  assert.equal(ra.key, 'user/cat');

  const b = tmpPet({ 'pet.json': '{ oops' });
  assert.ok(loadPet('user', b.petDir).errors[0].includes('JSON'));
});

test('带 BOM 的 pet.json 也能读', () => {
  const { petDir } = tmpPet({
    'pet.json': '﻿' + JSON.stringify({ id: 'cat', name: '猫', animations: { idle: { src: 'idle.gif' } } }),
    'idle.gif': 'GIF89a',
  });
  assert.ok(loadPet('user', petDir).pet);
});

test('resolveInside 拒绝越界路径', () => {
  const root = path.resolve('/pets/cat');
  assert.equal(resolveInside(root, 'a/b.png'), path.join(root, 'a', 'b.png'));
  assert.equal(resolveInside(root, '../dog/x.png'), null);
  assert.equal(resolveInside(root, ''), null);
});
