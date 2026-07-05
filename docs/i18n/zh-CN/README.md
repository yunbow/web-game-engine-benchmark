# Web Game Engine Benchmark

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../../../LICENSE)

一个基准测试合集，在多个 OSS Web 游戏引擎 / 3D 库中实现相同规格的迷你游戏，并**并排比较**它们。

- **2D: 13 个主题 × 7 个引擎 = 91 个实现**（Phaser 4 / PixiJS v8 / Babylon.js / LittleJS / three.js / KAPLAY / A-Frame）
- **3D: 10 个主题 × 4 个库 = 40 个实现**（three.js / Babylon.js / PlayCanvas / A-Frame）

每个主题都经过设计，只分离出一个想要比较的“负载轴”（例如渲染吞吐量 / 刚体物理 / GPU 粒子 / 深度排序 / 动态纹理传输……）。所有实现共享同一份规格（`SPEC.md`）、同样的操作方式和同样的 HUD，因此可以用 `+` / `-` 键增减负载来比较行为和 FPS。

## 🎮 试玩演示（GitHub Pages）

**▶ 演示门户: <https://yunbow.github.io/web-game-engine-benchmark/demo/>**

通往全部 131 个实现的入口。可以从 2D/3D 标签页中选择主题 × 引擎来启动。

- 单个演示的 URL 示例: [`demo/2d/01/Phaser4/`](https://yunbow.github.io/web-game-engine-benchmark/demo/2d/01/Phaser4/index.html)（弹幕射击游戏，Phaser 4 版本）
- 自动 FPS 测量: [2D 测试装置](https://yunbow.github.io/web-game-engine-benchmark/demo/2d/_bench/index.html) / [3D 测试装置](https://yunbow.github.io/web-game-engine-benchmark/demo/3d/_bench/index.html)

> 即使没有放置图像资源，每个游戏也会以纯色图形的回退方式启动。

## 主题列表

### 2D（13 个主题 × 7 个引擎）

| # | 类型 | 主要比较轴（通过 `+`/`-` 增减的负载） |
|---|---|---|
| 01 | 弹幕射击（纵版弹幕射击） | 渲染吞吐量（子弹/敌人的数量） |
| 02 | 俯视角生存 | 大量实体的更新 + 自定义碰撞检测 |
| 03 | 俯视角 RPG 探索 | 大地图渲染 + 可视范围裁剪 |
| 04 | 打砖块（多球） | 多球 × 多砖块的碰撞解算 |
| 05 | 横版卷轴动作 | 宽幅地图渲染 + 重力/AABB 物理 |
| 06 | 塔防 | 寻路（A*）+ 大量单位的追踪 |
| 07 | 物理解谜（抛射体物理） | 刚体物理引擎集成与刚体数量扩展 |
| 08 | 粒子/魔法特效 | GPU/粒子机制 + 加法混合 |
| 09 | 等距视角城市/农场 | 深度排序（z-order）+ 瓦片深度渲染 |
| 10 | 三消解谜 | 逻辑主导、轻量渲染 × 大量补间动画 |
| 11 | 2D 动态光照/阴影 | 多光源 + 光照贴图合成 + 阴影生成 |
| 12 | 下落沙粒/元胞自动机 | 网格单元更新 + 每帧全屏纹理重写 |
| 13 | 大量文本/UI 渲染 | 大量动态文本元素 + 字形重绘 |

### 3D（10 个主题 × 4 个库）

| # | 主题 | 主要比较轴（`+`/`-`） |
|---|---|---|
| 01 | 实例化小行星场（3D STG） | 单一网格的大量实例化渲染（最多 50,000） |
| 02 | 箱塔倒塌（3D 刚体物理） | 物理引擎集成（Rapier/Havok/ammo）+ 刚体数量 |
| 03 | 蒙皮角色群（glTF） | 蒙皮/骨骼动画播放吞吐量 |
| 04 | GPU 粒子（魔法/喷泉） | 粒子机制吞吐量 + 加法发光（最多 500,000） |
| 05 | 大范围地形裁剪/LOD | 视锥体裁剪 + 距离 LOD（绘制距离） |
| 06 | 动态阴影光源 | 实时阴影贴图数量 |
| 07 | 体素区块再生成 | 每帧顶点缓冲区重建/重新上传 |
| 08 | PBR + 后处理（Bloom） | PBR 着色 + Bloom 合成 |
| 09 | 3D 导航人群（A*） | 网格 A* 寻路 + 大量代理的追踪 |
| 10 | 大量射线检测（LIDAR） | 每帧的射线-网格相交 |

为了消除后端差异，3D **将所有库固定为 WebGL2**（不使用 WebGPU）。

## 📊 性能测量（`_bench`）

`demo/2d/_bench/` 和 `demo/3d/_bench/` 附带**自动 FPS 测量装置**。每个游戏都在 iframe 中依次启动，测量装置直接计数 iframe 内的 `requestAnimationFrame` 来实测 FPS（游戏本身不做任何修改，测量也不依赖 HUD 显示）。

- 负载控制: 通过合成按键事件发送 `+`，在所有引擎中统一应用负载等级 `0 / 10 / 25`
- 测量周期: 3.5s 启动等待 → 1.5s 稳定 → 8s 采样
- 输出 CSV: `theme, engine, level, fps_avg, fps_1pct_low, objects, transferKB, initMs, frames, error`
  - `fps_1pct_low` = 根据帧时间的第 99 百分位计算出的 1% low（卡顿指标）
  - `transferKB` / `initMs` = 初始传输大小 / 到 DOMContentLoaded 的时间

在浏览器中打开 [2D 测试装置](https://yunbow.github.io/web-game-engine-benchmark/demo/2d/_bench/index.html) / [3D 测试装置](https://yunbow.github.io/web-game-engine-benchmark/demo/3d/_bench/index.html) 来运行测量（**推荐使用 Chrome，测量期间请保持标签页在前台** —— 后台标签页会限制 rAF，使结果失效）。测量结果会以 CSV 文件下载。

### 测量结果

> 📝 敬请期待 —— 在统一环境下对所有主题/引擎完成全面测量后，将在此处发布 FPS 实测结果表（并注明测量环境）。

## 本地运行

直接以 `file://` 方式打开无法加载图像（CORS）。请以 `demo/` 为根目录启动 HTTP 服务器:

```bash
cd demo
python -m http.server 8000
# → http://localhost:8000/            (门户)
# → http://localhost:8000/2d/01/Phaser4/   (单个演示)
```

如需在本地运行测试装置，2D 请以 `demo/2d/` 为根目录提供服务，3D 请以 `demo/3d/` 为根目录提供服务，然后打开 `_bench/`。

## 目录结构

```
├─ demo/
│  ├─ index.html        … 演示门户（通往全部 131 个实现的入口）
│  ├─ 2d/
│  │  ├─ 01/ … 13/      … 2D 主题（每个主题结构相同）
│  │  │  ├─ SPEC.md     … 所有引擎共通的规格（数值/规则的唯一权威来源）
│  │  │  ├─ assets/     … 图像资源（由 gptimage2 生成）
│  │  │  ├─ Phaser4/    … index.html + game.js + README.md
│  │  │  ├─ PixiJS/  Babylon.js/  LittleJS/  three.js/  KAPLAY/  A-Frame/
│  │  └─ _bench/        … 2D 自动 FPS 测量装置
│  └─ 3d/
│     ├─ 01/ … 10/      … 3D 主题（three.js / Babylon.js / PlayCanvas / A-Frame）
│     └─ _bench/        … 3D 自动 FPS 测量装置
├─ docs/                … 引擎选型与主题设计的调研笔记
│  ├─ IMAGE_PROMPTS.md  … 图像资源生成提示词集（用于 gptimage2）
│  └─ i18n/             … README 多语言版本（ja / zh-CN / ko / es）
└─ README.md
```

各引擎文件夹的 `README.md` 记录了**运行方法、所用版本、实现说明以及对 AI 辅助编程的感想**。

## 所有实现遵循的共通规格

- **`SPEC.md` 是唯一的权威来源**: 速度、HP、生成上限、碰撞检测方式等数值，在同一主题的所有引擎中完全一致
- **共通 HUD**: 屏幕左上角显示 `FPS`（移动平均）/ `Objects` / `Score` / `HP` / 当前负载设置
- **通过 `+` / `-` 键增减负载**（每个主题的主要负载轴不同）
- **图像缺失时始终以纯色图形回退方式启动**
- **物理引擎原则上从零自行实现**（例外是 2d/07 和 3d/02，这两处物理引擎集成本身就是比较对象）
- **确定性生成（不使用 `Math.random`）** —— 使得可以通过自动游玩进行无人值守的基准测试

## 经验总结（精选）

### 在所有引擎中都行之有效的通用性能优化技巧

- **自定义圆形碰撞检测（平方距离比较）** —— 大量碰撞检测的决定性技巧
- **对象池复用**（零分配/零释放） —— 生存类游戏可达到数百至数千个实体
- **仅渲染可见区域（裁剪）** —— 将 100×100 地图的实际渲染压缩到约 600 个瓦片
- **轴分离 AABB + 逐面反射** —— 无需物理引擎即可稳定处理多球碰撞和横版卷轴地形
- 在所有情况下，这些都是如果不明确指示，AI 往往会省略的优化

### AI 编程适配性（★越多越容易编写）

| 引擎 | 适配性 | 要点 |
|---|---|---|
| **Phaser 4** | ★★★★★ | API 稳定；Phaser 3 的经验可以延用。大规模优化需要明确指示使用对象池 / 不使用物理引擎 |
| **PixiJS v8** | ★★★★☆ | 逻辑实际上等同于原生 JS。最大的陷阱是 **v8 的破坏性变更**（`await app.init()`、`app.canvas`、新的 Graphics API）—— 明确指定 v8 是成功的关键 |
| **LittleJS** | ★★★☆☆ | 单一 CDN，整体易于把握。需注意 ESM/classic 混用、Y 轴朝上，以及 WebGL 层与 HUD 的重叠 |
| **Babylon.js** | ★★★☆☆ | 用 3D 引擎编写 2D 时，**初始坐标系设置**（Y 轴向上/原点居中）是最难的部分。SpriteManager 的批处理对大量精灵表现良好 |

关于 three.js / KAPLAY / A-Frame / PlayCanvas 的感想，请参见各引擎文件夹的 `README.md`。

## 关于图像资源

素材是将 [`IMAGE_PROMPTS.md`](../../IMAGE_PROMPTS.md) 中的提示词输入图像生成 AI（gptimage2）后创建，并放置在各主题的 `assets/` 文件夹中。即使没有图像，所有游戏也能以图形回退方式启动，因此可以先进行逻辑比较，之后再替换图像。

## 相关调研笔记

- [`docs/game-engine-oss-codex-research.md`](../../game-engine-oss-codex-research.md) —— 引擎选型背后的前期调研（许可证、AI 适配性、性能的比较）
- [`docs/3d-engine-theme-research.md`](../../3d-engine-theme-research.md) —— 针对 3D 基准测试的候选库与比较主题的调研

## 许可证

[MIT](../../../LICENSE)

## 贡献

详情请参见 [CONTRIBUTING.md](../../../CONTRIBUTING.md)。

---

Languages: [English](../../../README.md) | [日本語](../ja/README.md) | 简体中文 | [한국어](../ko/README.md) | [Español](../es/README.md)
