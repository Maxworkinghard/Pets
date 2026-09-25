import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeManifest, fromCodexManifest, isCodexManifest, safeRelPath, referencedFiles } from '../src/shared/manifest.js';

const minimal = () => ({ id: 'cat', name: '猫', animations: { idle: { src: 'idle.gif' } } });

test('最小合法清单：只要 id、name 和 idle', () => {
  const { pet, errors } = normalizeManifest(minimal(), { dirName: 'cat' });
  assert.deepEqual(errors, []);
  assert.equal(pet.scale, 1);
  assert.equal(pet.animations.idle.kind, 'image');
  assert.equal(pet.animations.idle.repeat, 1);
  assert.deepEqual(pet.actions, []);
});

test('缺少 idle、name 为空时报错', () => {
  const { pet, errors } = normalizeManifest({ id: 'cat', name: ' ', animations: { walk: { src: 'w.gif' } } });
  assert.equal(pet, null);
  assert.ok(errors.some((e) => e.includes('idle')));
  assert.ok(errors.some((e) => e.includes('name')));
});

test('src / frames / sheet 必须且只能有一个', () => {
  const raw = minimal();
  raw.animations.idle = { src: 'a.gif', frames: ['b.png'] };
  assert.ok(normalizeManifest(raw).errors.some((e) => e.includes('只能有')));
  raw.animations.idle = { fps: 3 };
  assert.ok(normalizeManifest(raw).errors.some((e) => e.includes('只能有')));
});

test('frames 支持字符串与 {src, duration, offset} 混写，未写的时长按 fps 计算', () => {
  const raw = minimal();
  raw.animations.idle = { fps: 4, frames: ['a.png', { src: 'b.png', duration: 900, offset: [0, -6] }] };
  const { pet, errors } = normalizeManifest(raw);
  assert.deepEqual(errors, []);
  assert.deepEqual(pet.animations.idle.frames, [
    { src: 'a.png', duration: 250, offset: [0, 0] },
    { src: 'b.png', duration: 900, offset: [0, -6] },
  ]);
});

test('路径只能是宠物目录内的相对路径', () => {
  assert.equal(safeRelPath('frames\\a.png'), 'frames/a.png');
  assert.equal(safeRelPath('./a.gif'), 'a.gif');
  for (const bad of ['../x.png', 'a/../../x.png', '/etc/passwd', 'C:/x.png', '', 'a//b.png']) {
    assert.equal(safeRelPath(bad), null, bad);
  }
  const raw = minimal();
  raw.animations.idle.src = '../secret.gif';
  assert.ok(normalizeManifest(raw).errors.some((e) => e.includes('路径无效')));
});

test('fileExists 回调用于检查素材是否存在', () => {
  const { errors } = normalizeManifest(minimal(), { fileExists: () => false });
  assert.ok(errors.some((e) => e.includes('文件不存在：idle.gif')));
});

test('behavior 只能指向已有动画；有 label 的动画成为可选动作', () => {
  const raw = minimal();
  raw.animations.wave = { src: 'wave.gif', label: '挥手' };
  raw.behavior = { click: 'wave', doubleClick: 'nope' };
  assert.ok(normalizeManifest(raw).errors.some((e) => e.includes('doubleClick')));
  delete raw.behavior.doubleClick;
  const { pet } = normalizeManifest(raw);
  assert.deepEqual(pet.actions, ['wave']);
  assert.equal(pet.animations.wave.weight, 1);
  assert.equal(pet.animations.idle.weight, 0);
});

test('未知字段只给警告；id 与目录名不一致给警告', () => {
  const raw = minimal();
  raw.animations.idle.speeed = 3;
  const { pet, warnings } = normalizeManifest(raw, { dirName: 'dog' });
  assert.ok(pet);
  assert.ok(warnings.some((w) => w.includes('speeed')));
  assert.ok(warnings.some((w) => w.includes('目录名')));
});

test('Codex / Petdex 清单自动映射为 9 行精灵图动画', () => {
  const codex = { id: 'cat', displayName: 'Cat', description: 'x', spritesheetPath: 'spritesheet.webp' };
  assert.ok(isCodexManifest(codex));
  const { pet, errors } = normalizeManifest(codex, { dirName: 'cat' });
  assert.deepEqual(errors, []);
  assert.equal(pet.format, 'codex');
  assert.equal(pet.name, 'Cat');
  assert.deepEqual(Object.keys(pet.animations), [
    'idle', 'walk-right', 'walk-left', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review',
  ]);
  assert.deepEqual(pet.animations['walk-left'].sheet, { src: 'spritesheet.webp', cell: [192, 208], row: 2, col: 0, count: 8 });
  assert.equal(pet.behavior.click, 'waving');
  assert.deepEqual(referencedFiles(pet), ['spritesheet.webp']);
  assert.equal(fromCodexManifest({ spritesheetPath: 's.png' }, 'dir').id, 'dir');
});
