// 设置持久化：userData/settings.json
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_SETTINGS = {
  activePet: null, // 当前桌宠的 key，如 "bundled/my-cat"
  petVisible: true,
  size: 1, // 在宠物自身 scale 之上的整体缩放
  wander: true, // 自由走动
  randomActions: true, // 空闲时随机做动作
  gravity: true, // 松手后落到任务栏上
  alwaysOnTop: true,
  launchAtLogin: false,
  position: null, // 上次的脚底位置 {x, y}
};

export class Settings {
  constructor(file) {
    this.file = file;
    let saved = {};
    try {
      saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      // 首次启动或文件损坏：使用默认值
    }
    this.data = { ...DEFAULT_SETTINGS, ...saved };
  }

  set(patch) {
    this.data = { ...this.data, ...patch };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
    return this.data;
  }
}
