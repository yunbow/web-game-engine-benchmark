# Web Game Engine Benchmark

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

A benchmark collection that implements the same-spec mini-games across multiple OSS web game engines / 3D libraries and compares them **side by side**.

- **2D: 13 themes × 7 engines = 91 implementations** (Phaser 4 / PixiJS v8 / Babylon.js / LittleJS / three.js / KAPLAY / A-Frame)
- **3D: 10 themes × 4 libraries = 40 implementations** (three.js / Babylon.js / PlayCanvas / A-Frame)

Each theme is designed to isolate exactly one "load axis" you want to compare (e.g. rendering throughput / rigid-body physics / GPU particles / depth sorting / dynamic texture transfer, ...). Every implementation shares the same spec (`SPEC.md`), the same controls, and the same HUD, so you can increase or decrease the load with the `+` / `-` keys and compare behavior and FPS.

## 🎮 Play the Demos (GitHub Pages)

**▶ Demo portal: <https://yunbow.github.io/web-game-engine-benchmark/demo/>**

The entry point to all 131 implementations. Pick a theme × engine from the 2D/3D tabs to launch it.

- Example individual demo URL: [`demo/2d/01/Phaser4/`](https://yunbow.github.io/web-game-engine-benchmark/demo/2d/01/Phaser4/index.html) (bullet-hell shooter, Phaser 4 version)
- Automated FPS measurement: [2D bench harness](https://yunbow.github.io/web-game-engine-benchmark/demo/2d/_bench/index.html) / [3D bench harness](https://yunbow.github.io/web-game-engine-benchmark/demo/3d/_bench/index.html)

> Even without image assets placed, every game launches with a solid-color shape fallback.

## Theme List

### 2D (13 themes × 7 engines)

| # | Genre | Main comparison axis (load increased/decreased with `+`/`-`) |
|---|---|---|
| 01 | Bullet-hell shooter (vertical shmup) | Rendering throughput (volume of bullets/enemies) |
| 02 | Top-down survivor | Updating massive entity counts + custom collision |
| 03 | Top-down RPG exploration | Large map rendering + viewport culling |
| 04 | Breakout (multi-ball) | Collision resolution for many balls × many blocks |
| 05 | Side-scrolling action | Wide map rendering + gravity/AABB physics |
| 06 | Tower defense | Pathfinding (A*) + tracking large numbers of units |
| 07 | Physics puzzle (projectile physics) | Rigid-body physics engine integration and rigid-body count scaling |
| 08 | Particles/magic effects | GPU/particle mechanism + additive blending |
| 09 | Isometric city/farm | Depth sorting (z-order) + tile depth rendering |
| 10 | Match-3 puzzle | Logic-heavy, light rendering × many tweens |
| 11 | 2D dynamic lighting/shadows | Multiple lights + light-map compositing + shadow generation |
| 12 | Falling sand/cellular automaton | Grid cell updates + full-texture rewrite every frame |
| 13 | Mass text/UI rendering | Many dynamic text elements + glyph re-rendering |

### 3D (10 themes × 4 libraries)

| # | Theme | Main comparison axis (`+`/`-`) |
|---|---|---|
| 01 | Instanced asteroid field (3D STG) | Massive instanced rendering of a single mesh (up to 50,000) |
| 02 | Box tower collapse (3D rigid-body physics) | Physics engine integration (Rapier/Havok/ammo) + rigid-body count |
| 03 | Skinned character horde (glTF) | Skinning/skeletal animation playback throughput |
| 04 | GPU particles (magic/fountain) | Particle mechanism throughput + additive glow (up to 500,000) |
| 05 | Wide-area terrain culling/LOD | Frustum culling + distance LOD (draw distance) |
| 06 | Dynamic shadow lighting | Number of real-time shadow maps |
| 07 | Voxel chunk regeneration | Vertex buffer rebuild/re-upload every frame |
| 08 | PBR + post-processing (Bloom) | PBR shading + Bloom compositing |
| 09 | 3D navigation crowd (A*) | Grid A* pathfinding + tracking large numbers of agents |
| 10 | Mass raycasting (LIDAR) | Ray-mesh intersection every frame |

To eliminate backend differences, 3D **fixes all libraries to WebGL2** (no WebGPU).

## 📊 Performance Measurement (`_bench`)

`demo/2d/_bench/` and `demo/3d/_bench/` ship with an **automated FPS measurement harness**. Each game is launched sequentially in an iframe, and the harness directly counts `requestAnimationFrame` inside the iframe to measure actual FPS (the game itself is unmodified and the measurement does not depend on the HUD display).

- Load control: sends `+` via synthetic key events, applying load levels `0 / 10 / 25` uniformly across all engines
- Measurement cycle: 3.5s startup wait → 1.5s settling → 8s sampling
- Output CSV: `theme, engine, level, fps_avg, fps_1pct_low, objects, transferKB, initMs, frames, error`
  - `fps_1pct_low` = the 1% low computed from the 99th percentile of frame time (a stutter indicator)
  - `transferKB` / `initMs` = initial transfer size / time to DOMContentLoaded

Run the measurement by opening the [2D harness](https://yunbow.github.io/web-game-engine-benchmark/demo/2d/_bench/index.html) / [3D harness](https://yunbow.github.io/web-game-engine-benchmark/demo/3d/_bench/index.html) in your browser (**Chrome recommended, keep the tab in the foreground during measurement** — background tabs throttle rAF and invalidate results). The results are downloaded as a CSV.

### Measurement Results

> 📝 Coming soon — after a full measurement pass across all themes/engines in a unified environment, a table of measured FPS results (with the measurement environment noted) will be published here.

## Running Locally

Opening via `file://` directly does not work for image loading (CORS). Serve `demo/` as the root with an HTTP server:

```bash
cd demo
python -m http.server 8000
# → http://localhost:8000/            (portal)
# → http://localhost:8000/2d/01/Phaser4/   (individual demo)
```

To run the bench harness locally, serve `demo/2d/` as the root for 2D or `demo/3d/` as the root for 3D, then open `_bench/`.

## Directory Structure

```
├─ demo/
│  ├─ index.html        … Demo portal (entry point to all 131 implementations)
│  ├─ 2d/
│  │  ├─ 01/ … 13/      … 2D themes (each theme follows the same layout)
│  │  │  ├─ SPEC.md     … Spec shared by all engines (single source of truth for numbers/rules)
│  │  │  ├─ assets/     … Image assets (generated with gptimage2)
│  │  │  ├─ Phaser4/    … index.html + game.js + README.md
│  │  │  ├─ PixiJS/  Babylon.js/  LittleJS/  three.js/  KAPLAY/  A-Frame/
│  │  └─ _bench/        … 2D automated FPS measurement harness
│  └─ 3d/
│     ├─ 01/ … 10/      … 3D themes (three.js / Babylon.js / PlayCanvas / A-Frame)
│     └─ _bench/        … 3D automated FPS measurement harness
├─ docs/                … Research notes on engine selection and theme design
│  ├─ IMAGE_PROMPTS.md  … Image asset generation prompts (for gptimage2)
│  └─ i18n/             … Localized README versions (ja / zh-CN / ko / es)
└─ README.md
```

Each engine folder's `README.md` documents **how to run it, the version used, implementation notes, and impressions of AI-assisted coding**.

## Common Spec Followed by All Implementations

- **`SPEC.md` is the single source of truth**: numeric values such as speed, HP, spawn caps, and collision detection method are identical across all engines for the same theme
- **Common HUD**: top-left of the screen shows `FPS` (moving average) / `Objects` / `Score` / `HP` / the current load setting
- **Load is increased/decreased with the `+` / `-` keys** (the primary load axis differs per theme)
- **When images are missing, the game always launches with a solid-color shape fallback**
- **Physics engines are implemented from scratch in principle** (exceptions are 2d/07 and 3d/02, where physics-engine integration itself is the point of comparison)
- **Deterministic generation (`Math.random` is not used)** — enables unattended benchmarking via autoplay

## Lessons Learned (Highlights)

### Common Performance Techniques That Paid Off Across All Engines

- **Custom circle collision (squared-distance comparison)** — the decisive technique for mass collision detection
- **Object pool reuse** (zero allocation/deallocation) — survivor-genre games reach hundreds to thousands of entities
- **Rendering only the visible area (culling)** — compresses actual rendering of a 100×100 map down to ~600 tiles
- **Axis-separated AABB + per-face reflection** — handles multi-ball collision and side-scrolling terrain stably without a physics engine
- In every case, these are the kind of optimizations an AI tends to omit unless explicitly instructed to include them

### AI Coding Compatibility (more ★ = easier to write)

| Engine | Compatibility | Key points |
|---|---|---|
| **Phaser 4** | ★★★★★ | Stable API; Phaser 3 knowledge carries over. Large-scale optimization requires explicit instructions to use pooling / avoid the physics engine |
| **PixiJS v8** | ★★★★☆ | Logic is effectively plain JS. The biggest pitfall is the **v8 breaking changes** (`await app.init()`, `app.canvas`, the new Graphics API) — explicitly specifying v8 is the key to success |
| **LittleJS** | ★★★☆☆ | Single CDN; easy to grasp as a whole. Watch out for ESM/classic mix-ups, the Y-axis pointing up, and overlap between the WebGL layer and the HUD |
| **Babylon.js** | ★★★☆☆ | The **initial coordinate-system setup** (Y-up / origin at center) when writing 2D with a 3D engine is the hardest part. SpriteManager's batching handles large numbers of sprites well |

See each engine folder's `README.md` for impressions of three.js / KAPLAY / A-Frame / PlayCanvas.

## About Image Assets

Assets are created by feeding the prompts in [`IMAGE_PROMPTS.md`](./docs/IMAGE_PROMPTS.md) into an image-generation AI (gptimage2) and placing them in each theme's `assets/` folder. Every game launches with a shape fallback even without images, so logic comparison can happen first, with images swapped in later.

## Related Research Notes

- [`docs/game-engine-oss-codex-research.md`](./docs/game-engine-oss-codex-research.md) — Preliminary research behind engine selection (comparison of licensing, AI compatibility, and performance)
- [`docs/3d-engine-theme-research.md`](./docs/3d-engine-theme-research.md) — Research into candidate libraries and comparison themes for the 3D benchmark

## License

[MIT](./LICENSE)

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for details.

---

Languages: English | [日本語](docs/i18n/ja/README.md) | [简体中文](docs/i18n/zh-CN/README.md) | [한국어](docs/i18n/ko/README.md) | [Español](docs/i18n/es/README.md)
