# 宠物仓库

这里的每个文件夹是一只宠物：`pet.json`（清单）+ 素材文件。桌面端会扫描这个目录，在「宠物仓库」里展示，选中就能放到桌面上。

> 宠物包只放在本地：这个目录下的宠物文件夹已被 `.gitignore` 忽略，不会提交到 Git。仓库里只有这份格式说明。

## 目录结构

```text
pets/
└─ my-cat/                 ← 文件夹名就是 id
   ├─ pet.json
   ├─ gifs/idle.gif        ← 素材放哪、叫什么都行，pet.json 里写相对路径
   └─ frames/walk_0.png
```

## pet.json

最小的宠物只需要一个待机动画：

```json
{
  "$schema": "../../schema/pet.schema.json",
  "id": "my-cat",
  "name": "我的猫",
  "animations": {
    "idle": { "src": "idle.gif" }
  }
}
```

写上 `$schema` 后，VS Code 等编辑器会根据 [`schema/pet.schema.json`](../schema/pet.schema.json) 给出补全和错误提示。

一个更完整的例子：

```json
{
  "id": "my-cat",
  "name": "小猫",
  "description": "会散步、会打招呼，双击趴下睡一会儿。",
  "tags": ["像素", "猫"],
  "scale": 0.6,
  "speed": 90,
  "behavior": { "click": "wave", "doubleClick": "nap" },
  "animations": {
    "idle": { "frames": [{ "src": "frames/idle_a.png", "duration": 420 }, { "src": "frames/idle_b.png", "duration": 420 }] },
    "walk-right": { "frames": ["frames/walk_a.png", "frames/walk_b.png"], "stepDistance": 28 },
    "walk-left": { "frames": ["frames/walk_a_flip.png", "frames/walk_b_flip.png"], "stepDistance": 28 },
    "wave": { "label": "打招呼", "repeat": 2, "frames": [{ "src": "frames/wave_a.png", "duration": 200 }, { "src": "frames/wave_b.png", "duration": 200 }] },
    "nap": { "label": "趴下睡觉", "src": "gifs/nap.gif" }
  }
}
```

### 顶层字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | ✓ | 小写字母、数字、`-` `_` `.`；在仓库里必须与文件夹名相同 |
| `name` | ✓ | 显示名称 |
| `animations` | ✓ | 动画表，至少要有 `idle` |
| `description` |  | 一两句话的介绍 |
| `tags` |  | 标签，用于搜索和卡片展示 |
| `scale` |  | 默认显示倍率（素材 1 像素 = 屏幕 `scale` 个像素），默认 1。用户还能在设置里整体缩放 |
| `pixelated` |  | `true` 时缩放用最近邻采样，适合大颗粒像素画 |
| `speed` |  | 走路速度，素材像素/秒，默认 50 |
| `behavior.click` / `behavior.doubleClick` |  | 单击 / 双击宠物时播放的动画名 |
| `codex` |  | 导入到 Codex 时各状态用哪个动画，见下文 |
| `author` `version` `license` |  | 作者、版本、素材授权 |

### 动画：三种素材写法

每个动画从下面三种里选一种：

| 写法 | 例子 | 适合 |
| --- | --- | --- |
| `src` 动图 | `{ "src": "gifs/idle.gif" }` | GIF / APNG / 动态 WebP，帧时长取自文件（也可以用 `fps` 覆盖）；静态 PNG 也行 |
| `frames` 帧序列 | `{ "frames": ["a.png", { "src": "b.png", "duration": 900, "offset": [0, -6] }], "fps": 6 }` | 逐帧 PNG。每帧可以单独设时长和偏移，同一张图可重复引用 |
| `sheet` 精灵图 | `{ "sheet": { "src": "sheet.png", "cell": [192, 208], "row": 2, "count": 8 }, "fps": 5.5 }` | 从第 `row` 行、第 `col` 列（默认 0）起向右取 `count` 格 |

动画的其它字段：

| 字段 | 说明 |
| --- | --- |
| `fps` | 帧率；`frames` / `sheet` 默认 8 |
| `repeat` | 作为动作播放时重复几遍，默认 1 |
| `label` | 写了 `label` 的动画会出现在右键菜单「动作」里，并参与随机动作 |
| `weight` | 随机动作的权重（有 `label` 时默认 1），`0` 表示只能手动触发 |
| `mirror` | 只对通用的 `walk` / `drag` 生效：向左走时是否水平镜像，默认 `true`（素材默认朝右） |
| `anchor` | 脚底锚点 `[x, y]`，见下文 |
| `moveX` | 动画自带的水平位移（素材像素，负数向左）。播完后宠物位置跟着平移，适合「钻进地里、从旁边钻出来」这类画面里自带位移的动画 |
| `stepDistance` | 每移动这么多素材像素换一帧：脚步和位移同步，拖动时也按拖动距离迈步 |

### 约定的动画名

| 名字 | 什么时候播放 | 没有这个动画时 |
| --- | --- | --- |
| `idle` | 待机（必需） | — |
| `walk-right` / `walk-left` / `walk` | 自由走动；拖着宠物水平移动时 | 不会自己走 |
| `drag-right` / `drag-left` / `drag` | 被拖动时 | 水平拖动时用走路动画，停住时用 `idle` |
| `fall` | 松手后落回任务栏 | 用拖动的动画 |
| `sleep` | 偶尔打个盹，单击叫醒 | 不睡觉 |

其它名字都是**自定义动作**，比如 `wave`、`smoke-sit`、`ultimate-acid`。

### 对齐：脚底锚点

宠物在桌面上的位置指的是它的「脚底锚点」：站在任务栏上时，锚点就压在任务栏上沿。

- **默认锚点**：画框底边居中，且离底边的距离和 `idle` 第一帧一样。大多数素材（每个动画画框一样大、角色居中）不需要任何设置。
- **帧序列**里尺寸不同的帧按「底边居中」对齐。
- 某个动画的画框大小或构图不一样（例如坐到键盘前的场景、向一侧喷吐的攻击动作），用 `anchor` 写出这个动画里脚底所在的像素坐标。

## 兼容 Codex / Petdex 宠物

Codex 宠物（`pet.json` 里有 `spritesheetPath`，精灵图为 8 列 × 9 行、每格 192×208）不用转换就能用：放进「我的宠物」目录，或者直接放在 `~/.codex/pets`，桌面端会自动识别。九个状态行会映射成：

| Codex 行 | 动画 | 说明 |
| --- | --- | --- |
| `idle` | `idle` | 待机 |
| `running-right` / `running-left` | `walk-right` / `walk-left` | 走动、拖动 |
| `waving` | `waving` | 挥手（单击） |
| `jumping` | `jumping` | 跳一跳（双击） |
| `failed` `waiting` `running` `review` | 同名 | 右键菜单里的动作 |

## 导入到 Codex

桌面端详情里的「导入到 Codex」会把宠物转成 Codex 宠物（8×9 精灵图，每格 192×208），装进 `~/.codex/pets/<id>/`。Codex 的 9 个状态从哪个动画取帧，按下面的顺序决定：

1. `pet.json` 里的 `codex` 字段；
2. 同名动画，或常见命名：

   | Codex 状态 | 自动对应的动画名（按顺序找） |
   | --- | --- |
   | `running-right` / `running-left` | `walk-right` / `walk-left`、`walk`（向左时镜像）、`drag-right` / `drag-left` |
   | `waving` | `wave`、`behavior.click` 指向的动画 |
   | `jumping` | `jump`、`jump-happy`、`behavior.doubleClick` 指向的动画 |
   | `failed` | `error` |
   | `waiting` | `think`、`listening` |
   | `running` | `type-keyboard`、`type`、`working` |
   | `review` | `peek`、`point` |

3. 都没有就用 `idle`。

带 `moveX` 的动画不会被选用（它们靠移动窗口产生位移，放进格子里会出格）。所有选中的帧统一缩放、脚底对齐，所以某个动画特别宽或特别高时，整只宠物在格子里会变小——这种动画可以在 `codex` 里换掉。例如：

```json
"codex": { "running-right": "sway", "running-left": "sway", "waiting": "sway", "running": "attack", "review": "victory" }
```

## 校验

```bash
cd desktop
npm run validate                       # 校验 pets/
node scripts/validate-pets.js <目录>   # 校验其它目录
```

`pets/` 里的宠物还需满足：`id` 与文件夹名相同、`id` 不重复、文件名大小写与 `pet.json` 完全一致。校验会提示没被引用的文件和超过 5 MB 的大文件。

## 添加一只宠物

1. 新建 `pets/<id>/`，放入素材和 `pet.json`（或者在桌面端点「导入宠物」，它会被复制到「我的宠物」目录）。
2. `npm run validate` 通过后，`npm start` 在桌面端里预览、调整 `scale` / `anchor` / `speed`。

素材建议：透明背景；脚底尽量贴近画框底边；一只宠物的所有动画用相同画框；单个文件不超过 5 MB；在 `license` 里写明授权。
