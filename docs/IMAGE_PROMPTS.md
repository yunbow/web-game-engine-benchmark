# 画像生成プロンプト集（gptimage2 用）

5テーマ分のゲーム素材を **gptimage2**（GPT Image）で生成するためのプロンプト集。
生成した画像は各テーマの `assets/` フォルダに**指定ファイル名**で保存すること（ゲーム側がその名前で読み込む）。

## 共通ルール（全プロンプトに適用）
- スタイル: **16-bit ピクセルアート / レトロゲーム風**、はっきりした輪郭、限定パレット。
- 背景: **完全透過（transparent background, PNG with alpha）**。※タイル/背景画像を除く。
- 視点: 各テーマ指定（STG=真上見下ろし、サバイバー/RPG=トップダウン斜め見下ろし）。
- 1枚に**1オブジェクトのみ**（スプライトシート不要、単体スプライト）。中央配置・余白最小。
- 出力後、指定の**正方形/指定比率**にトリミング・リサイズして保存。
- タイル画像は**シームレスにタイリング可能（seamless tileable）**であること。
- 一貫性のため、同テーマ内は**同じパレット・同じ太さの輪郭・同じ画風**で揃えるよう各プロンプト末尾に指定済み。

> gptimage2 への渡し方のコツ: 「pixel art」「transparent background」「centered」「game asset」「top-down」を明示し、サイズは `1024x1024` で生成→後段でゲーム用pxへ縮小。透過が崩れる場合は "solid flat background, no gradient, isolated on transparent" を強調。

---

## テーマ1: 弾幕STG（保存先: `1/assets/`）
視点は**真上からの見下ろし（top-down, vertical shooter）**。機体は画面上方向を向く。

### `player_ship.png` (64x64)
```
Pixel art sprite of a small player spaceship fighter seen from directly above, nose pointing up, blue and white hull with glowing cyan engine thrusters, clean readable silhouette, 16-bit retro arcade shoot-em-up style, centered, isolated on a fully transparent background, no shadow, sharp pixel edges.
```

### `enemy_small.png` (48x48)
```
Pixel art sprite of a small enemy spaceship seen from directly above, pointing downward, red and dark-gray hull, aggressive angular shape, 16-bit retro arcade style, centered, isolated on a fully transparent background, matching the clean pixel outline style of a top-down shmup.
```

### `enemy_big.png` (96x96)
```
Pixel art sprite of a large enemy battle cruiser seen from directly above, pointing downward, dark purple and red armored hull with turrets, menacing, 16-bit retro arcade style, centered, isolated on a fully transparent background, same palette and outline style as the small red enemy.
```

### `bullet_player.png` (16x24)
```
Pixel art sprite of a glowing cyan energy bullet/laser bolt, vertical orientation, bright core with soft glow, 16-bit retro arcade style, centered, isolated on a fully transparent background.
```

### `bullet_enemy.png` (16x16)
```
Pixel art sprite of a round glowing magenta/red enemy plasma bullet orb, 16-bit retro arcade style, centered, isolated on a fully transparent background.
```

### `explosion.png` (64x64)
```
Pixel art sprite of a single-frame fiery explosion burst, orange-yellow flames with debris, 16-bit retro arcade style, centered, isolated on a fully transparent background.
```

### `bg_space.png` (512x512, タイル可)
```
Seamless tileable pixel art starfield background, dark deep-space navy/black with scattered small white and pale-blue stars and a few faint nebula wisps, 16-bit retro style, no characters, seamless on all four edges, no transparency (solid background).
```

---

## テーマ2: トップダウン・サバイバー（保存先: `2/assets/`）
視点は**トップダウン（やや斜め見下ろし、足元が見える）**。キャラは正面向き。

### `player.png` (48x48)
```
Pixel art sprite of a heroic adventurer character in a top-down view facing the camera, simple armor and a small cloak, holding a glowing wand, readable silhouette, 16-bit retro RPG style, centered, isolated on a fully transparent background, no shadow.
```

### `enemy_bat.png` (32x32)
```
Pixel art sprite of a small flying bat enemy seen from a top-down view, dark purple with spread wings, glowing red eyes, 16-bit retro RPG style, centered, isolated on a fully transparent background, matching the hero sprite's pixel outline style.
```

### `enemy_zombie.png` (40x40)
```
Pixel art sprite of a green zombie monster seen from a top-down view facing the camera, tattered clothes, lumbering pose, 16-bit retro RPG style, centered, isolated on a fully transparent background, same palette family as the bat enemy.
```

### `projectile.png` (24x24)
```
Pixel art sprite of a glowing yellow-white magic bolt orb with a short energy trail, 16-bit retro RPG style, centered, isolated on a fully transparent background.
```

### `xp_gem.png` (16x16)
```
Pixel art sprite of a small shiny cyan diamond-shaped experience gem with a bright highlight, 16-bit retro RPG style, centered, isolated on a fully transparent background.
```

### `ground_tile.png` (64x64, タイル可)
```
Seamless tileable pixel art dungeon/grass ground texture, dark mossy stone floor with subtle dirt and cracks, top-down view, 16-bit retro RPG style, seamless on all four edges, no characters, solid background (no transparency).
```

---

## テーマ3: トップダウンRPG探索（保存先: `3/assets/`）
視点は**トップダウン**。タイルは32x32でシームレス。キャラは正面向き。

### `tile_grass.png` (32x32, タイル可)
```
Seamless tileable pixel art grass ground tile, top-down view, bright green with subtle blade texture, 16-bit retro RPG style, seamless on all four edges, fills the whole frame, no transparency.
```

### `tile_path.png` (32x32, タイル可)
```
Seamless tileable pixel art dirt path/road tile, top-down view, warm brown with small pebbles, 16-bit retro RPG style, seamless on all four edges, fills the whole frame, matching the grass tile palette, no transparency.
```

### `tile_water.png` (32x32, タイル可)
```
Seamless tileable pixel art water tile, top-down view, blue with subtle ripple highlights, 16-bit retro RPG style, seamless on all four edges, fills the whole frame, no transparency.
```

### `tile_wall.png` (32x32, タイル可)
```
Seamless tileable pixel art stone wall/rock tile, top-down view, gray cobblestone, 16-bit retro RPG style, seamless on all four edges, fills the whole frame, no transparency.
```

### `tree.png` (32x48)
```
Pixel art sprite of a single round-canopy tree seen from a slight top-down angle, green leaves and brown trunk, 16-bit retro RPG style, centered, isolated on a fully transparent background, matching the grass tile palette.
```

### `player.png` (32x32)
```
Pixel art sprite of a young hero character in a top-down RPG view facing downward (toward camera), green tunic and small sword, classic top-down RPG look, 16-bit retro RPG style, centered, isolated on a fully transparent background, no shadow.
```

### `npc.png` (32x32)
```
Pixel art sprite of a friendly villager NPC in a top-down RPG view facing downward, brown robe, 16-bit retro RPG style, centered, isolated on a fully transparent background, same outline style as the hero.
```

### `enemy_slime.png` (32x32)
```
Pixel art sprite of a cute green slime monster in a top-down RPG view, glossy blob with two eyes, 16-bit retro RPG style, centered, isolated on a fully transparent background, matching the hero pixel style.
```

---

## テーマ4: ブロック崩し（保存先: `4/assets/`）
視点は**真正面（2D, 横から見た固定盤面）**。ブロックは明色で、ゲーム側が HP に応じて tint（赤/橙/緑）するため**白〜淡色のニュートラルな1枚**で生成する。

### `paddle.png` (96x24)
```
Pixel art sprite of a horizontal arcade breakout paddle/bar, glossy blue and white metallic capsule shape with rounded ends, seen from the front, 16-bit retro arcade style, centered, isolated on a fully transparent background, sharp pixel edges, no shadow.
```

### `ball.png` (16x16)
```
Pixel art sprite of a small round glossy white-silver ball with a bright highlight, 16-bit retro arcade breakout style, centered, isolated on a fully transparent background.
```

### `brick.png` (64x24)
```
Pixel art sprite of a single rectangular breakout brick with a light neutral near-white / pale-gray surface and a subtle beveled glossy highlight, plain so it can be color-tinted in code, 16-bit retro arcade style, centered, fills the frame edge to edge, no transparency needed (solid rectangle), sharp pixel edges.
```

### `hit_spark.png` (32x32)
```
Pixel art sprite of a small bright yellow-white impact spark burst / shatter star, single frame, 16-bit retro arcade style, centered, isolated on a fully transparent background.
```

### `bg_breakout.png` (512x512, タイル可)
```
Seamless tileable pixel art dark arcade background, deep navy-to-black with a subtle grid and faint neon glow, 16-bit retro style, no characters, seamless on all four edges, solid background (no transparency).
```

---

## テーマ5: 横スクロールアクション（保存先: `5/assets/`）
視点は**横から見た 2D サイドビュー**。キャラ/敵は横向き、タイルは32x32でシームレス。

### `player.png` (32x48)
```
Pixel art sprite of a small cartoon platformer hero character seen from the side facing right, red cap and shirt with blue overalls, simple readable silhouette, classic 16-bit retro platformer style, centered, isolated on a fully transparent background, no shadow, sharp pixel edges.
```

### `enemy_goomba.png` (32x32)
```
Pixel art sprite of a small brown mushroom-shaped walking enemy seen from the side, angry eyes and tiny feet, classic 16-bit retro platformer style, centered, isolated on a fully transparent background, matching the hero's pixel outline style.
```

### `tile_ground.png` (32x32, タイル可)
```
Seamless tileable pixel art ground/dirt block tile for a side-scrolling platformer, warm brown earth with a grassy green top edge texture, 16-bit retro style, seamless horizontally, fills the whole frame, no transparency.
```

### `tile_brick.png` (32x32, タイル可)
```
Seamless tileable pixel art orange-brown brick block tile for a side-scrolling platformer, classic mortar lines, 16-bit retro style, fills the whole frame, seamless, no transparency.
```

### `tile_pipe.png` (32x32, タイル可)
```
Pixel art green warp-pipe block tile for a side-scrolling platformer, glossy green with darker rim shading, 16-bit retro style, fills the whole frame, tileable vertically, no transparency.
```

### `coin.png` (24x24)
```
Pixel art sprite of a shiny golden coin seen from the front, bright yellow with a lighter highlight rim, 16-bit retro platformer style, centered, isolated on a fully transparent background.
```

### `bg_sky.png` (512x512, タイル可)
```
Seamless tileable pixel art bright daytime sky background with soft white clouds and distant rounded green hills along the bottom, 16-bit retro platformer style, no characters, seamless on the left and right edges, solid background (no transparency).
```

---

## テーマ6: タワーディフェンス（保存先: `6/assets/`）
視点は**真上からの見下ろし（top-down グリッド）**。経路を進む敵をタワーが撃つ。

### `creep.png` (24x24)
```
Pixel art sprite of a small menacing creature/slime enemy seen from top-down, round red-orange body with tiny legs and angry eyes, clean readable silhouette, 16-bit retro tower-defense style, centered, isolated on a fully transparent background, no shadow, sharp pixel edges.
```

### `tower.png` (32x32)
```
Pixel art sprite of a small defensive turret/cannon tower seen from top-down, blue and steel-gray base with a short barrel pointing outward, 16-bit retro tower-defense style, centered, isolated on a fully transparent background, matching the clean pixel outline style.
```

### `projectile.png` (12x12)
```
Pixel art sprite of a small round glowing yellow energy bullet orb, 16-bit retro style, centered, isolated on a fully transparent background, no shadow.
```

### `tile_path.png` (32x32, タイル可)
```
Seamless tileable pixel art of a dark dirt/stone walkway path tile seen from top-down, muted dark gray-brown, subtle texture, 16-bit retro style, seamless on all four edges, solid background (no transparency).
```

### `tile_wall.png` (32x32, タイル可)
```
Seamless tileable pixel art of a stone/concrete blocked wall tile seen from top-down, light gray bricks, 16-bit retro style, seamless on all four edges, solid background (no transparency).
```

### `base.png` (32x32)
```
Pixel art sprite of a friendly base/goal marker seen from top-down, a green flag on a small fortified platform, 16-bit retro tower-defense style, centered, isolated on a fully transparent background.
```

### `hit_spark.png` (32x32)
```
Pixel art sprite of a single-frame white-yellow impact spark burst, small radial flash, 16-bit retro style, centered, isolated on a fully transparent background.
```

---

## テーマ7: 物理パズル（保存先: `7/assets/`）
視点は**横から（side view）**。重力で落ちる箱の山を発射体で崩す。

### `box.png` (34x34)
```
Pixel art sprite of a wooden crate/box seen from the side, square brown wooden planks with metal corner brackets, 16-bit retro physics-puzzle style, centered, isolated on a fully transparent background, sharp pixel edges.
```

### `box_target.png` (34x34)
```
Pixel art sprite of a special target crate seen from the side, square box with a bright orange-and-white striped pattern and a star mark, same proportions as the wooden crate, 16-bit retro style, centered, isolated on a fully transparent background.
```

### `ball.png` (24x24)
```
Pixel art sprite of a round red cannonball / projectile with a slight metallic highlight, 16-bit retro style, centered, isolated on a fully transparent background, no shadow.
```

### `ground.png` (64x64, タイル可)
```
Seamless tileable pixel art of solid ground with green grass top and brown soil below, side-view platform style, 16-bit retro, seamless on the left and right edges, solid background (no transparency).
```

### `slingshot.png` (48x64)
```
Pixel art sprite of a wooden Y-shaped slingshot / catapult launcher seen from the side, brown wood with elastic band, 16-bit retro physics-puzzle style, centered, isolated on a fully transparent background.
```

### `bg_sky.png` (512x512, タイル可)
```
Seamless tileable pixel art bright daytime sky background with soft white clouds, 16-bit retro style, no characters, seamless on the left and right edges, solid background (no transparency).
```

---

## テーマ8: パーティクル/魔法エフェクト（保存先: `8/assets/`）
**加算合成（additive blend）前提**。中心が明るく外周が透明に落ちる放射状グローが重要。

### `particle_spark.png` (32x32)
```
Pixel art style soft radial glow particle, bright white-hot center fading smoothly to fully transparent at the edges, round symmetric spark for additive blending, on a fully transparent background, no hard outline, centered.
```

### `particle_smoke.png` (32x32)
```
Soft round smoke/haze puff, light gray semi-transparent cloud fading to transparent at the edges, for a particle system, on a fully transparent background, no hard outline, centered.
```

### `orb.png` (32x32)
```
Pixel art sprite of a glowing magical energy orb, bright cyan-white core with a soft luminous halo fading outward, 16-bit retro magic style, centered, isolated on a fully transparent background.
```

### `bg_dark.png` (512x512, タイル可)
```
Seamless tileable very dark night background, near-black deep navy with a few faint tiny stars, 16-bit retro style, no characters, seamless on all four edges, solid background (no transparency).
```

---

## テーマ9: アイソメトリック都市/農場（保存先: `9/assets/`）
視点は**アイソメtrический（2:1 斜め見下ろし）**。地面タイルは**菱形（64x32, diamond）**、建物/木は背高で足元が菱形中心に来るように。

### `tile_grass.png` (64x32)
```
Pixel art isometric grass ground tile, 2:1 diamond shape filling the image, fresh green with subtle blades texture, 16-bit retro isometric game style, the diamond touches the four edge midpoints, transparent background outside the diamond.
```

### `tile_soil.png` (64x32)
```
Pixel art isometric farm soil/dirt ground tile, 2:1 diamond shape, brown tilled earth with furrow rows, 16-bit retro isometric style, diamond touches the four edge midpoints, transparent background outside the diamond.
```

### `tile_water.png` (64x32)
```
Pixel art isometric water ground tile, 2:1 diamond shape, blue water with small wave highlights, 16-bit retro isometric style, diamond touches the four edge midpoints, transparent background outside the diamond.
```

### `tree.png` (48x64)
```
Pixel art isometric tree, tall green leafy canopy on a brown trunk, drawn so the trunk base sits at the bottom-center (the diamond footprint center), 16-bit retro isometric style, centered horizontally, isolated on a fully transparent background.
```

### `house.png` (64x64)
```
Pixel art isometric small house/cottage, walls with a pitched red roof drawn in 2:1 isometric perspective, footprint base at bottom-center, 16-bit retro isometric town style, centered, isolated on a fully transparent background.
```

### `villager.png` (24x32)
```
Pixel art sprite of a small villager character for an isometric game, simple front-facing pose, distinct readable silhouette, 16-bit retro style, feet at bottom-center, centered, isolated on a fully transparent background.
```

---

## テーマ10: マッチ3パズル（保存先: `10/assets/`）
正面から見た**宝石（gem）**。6種は**色と形のどちらでも識別できる**ように（色覚配慮）。盤面でセルサイズに拡縮されるので**正方形中央配置**。

### `gem_red.png` (64x64)
```
Pixel art sprite of a faceted red ruby gem, diamond/round-brilliant shape with bright highlights, glossy, match-3 puzzle style, 16-bit retro, centered, isolated on a fully transparent background.
```

### `gem_blue.png` (64x64)
```
Pixel art sprite of a faceted blue sapphire gem, distinct teardrop shape with bright highlights, glossy, match-3 puzzle style, 16-bit retro, centered, isolated on a fully transparent background.
```

### `gem_green.png` (64x64)
```
Pixel art sprite of a faceted green emerald gem, distinct square/rectangular cut with bright highlights, glossy, match-3 puzzle style, 16-bit retro, centered, isolated on a fully transparent background.
```

### `gem_yellow.png` (64x64)
```
Pixel art sprite of a faceted yellow topaz gem, distinct hexagon shape with bright highlights, glossy, match-3 puzzle style, 16-bit retro, centered, isolated on a fully transparent background.
```

### `gem_purple.png` (64x64)
```
Pixel art sprite of a faceted purple amethyst gem, distinct oval shape with bright highlights, glossy, match-3 puzzle style, 16-bit retro, centered, isolated on a fully transparent background.
```

### `gem_white.png` (64x64)
```
Pixel art sprite of a faceted white diamond gem, distinct star/marquise shape with bright sparkly highlights, glossy, match-3 puzzle style, 16-bit retro, centered, isolated on a fully transparent background.
```

### `bg_board.png` (512x512, タイル可)
```
Seamless tileable dark navy puzzle-board background with a subtle grid pattern, 16-bit retro style, no characters, seamless on all four edges, solid background (no transparency).
```

---

## テーマ11: 2Dダイナミックライティング/影（保存先: `11/assets/`）
視点は**トップダウン**。暗い部屋を前提にした素材。`light_glow.png` は**加算合成前提**（中心白→外周透明）。

### `tile_floor.png` (64x64, タイル可)
```
Seamless tileable pixel art dark stone dungeon floor tile seen from top-down, deep gray cobblestone with subtle cracks, low brightness so dynamic lights can pop, 16-bit retro style, seamless on all four edges, solid background (no transparency).
```

### `pillar.png` (64x64)
```
Pixel art sprite of a stone pillar / square block obstacle seen from top-down, gray masonry with a slightly lit top face and darker sides, clear square footprint for casting shadows, 16-bit retro dungeon style, centered, isolated on a fully transparent background.
```

### `light_glow.png` (256x256)
```
Soft radial light glow, bright warm white center fading smoothly and evenly to fully transparent at the circular edge, perfectly round, no hard outline, for additive light blending, on a fully transparent background, centered.
```

### `player_lamp.png` (32x48)
```
Pixel art sprite of a small adventurer holding a glowing lantern, top-down/slightly-front view, readable silhouette, the lantern emits a small warm highlight, 16-bit retro dungeon style, centered, isolated on a fully transparent background.
```

---

## テーマ12: フォーリングサンド/セルオートマトン（保存先: `12/assets/`）
**画像アセットは不要**。セルの色（砂/水/壁/空気）はコードで定義し、毎フレーム生成するピクセルバッファに直接書き込むため、生成すべきスプライトはありません（`assets/.gitkeep` のみ）。

## テーマ13: 大量テキスト/UI描画（保存先: `13/assets/`）
**画像アセットは不要**。各エンジンの既定/システムフォント（Canvas テキスト / TextBlock / draw_string 等）を使うため、外部フォント画像は生成しません（`assets/.gitkeep` のみ）。

---

## 生成→配置チェックリスト
- [ ] テーマ1: 7枚を `1/assets/` に保存（`player_ship.png` 等）
- [ ] テーマ2: 6枚を `2/assets/` に保存
- [ ] テーマ3: 8枚を `3/assets/` に保存
- [ ] テーマ4: 5枚を `4/assets/` に保存（`paddle.png` 等。`brick.png` は白〜淡色＝コード側でHP色tint）
- [ ] テーマ5: 7枚を `5/assets/` に保存（`player.png` 等）
- [ ] テーマ6: 7枚を `6/assets/` に保存（`creep.png` 等。`tile_path`/`tile_wall` はタイル可）
- [ ] テーマ7: 6枚を `7/assets/` に保存（`box.png` 等。`box_target` は色違い）
- [ ] テーマ8: 4枚を `8/assets/` に保存（**加算合成前提**＝中心白・外周透明の放射グロー）
- [ ] テーマ9: 6枚を `9/assets/` に保存（地面は**菱形64x32**, 木/家は足元中心）
- [ ] テーマ10: 7枚を `10/assets/` に保存（宝石6種は色＋形で識別 / `bg_board` はタイル可）
- [ ] テーマ11: 4枚を `11/assets/` に保存（`light_glow` は**加算前提**＝中心白・外周透明 / `tile_floor` はタイル可）
- [ ] テーマ12: **アセット不要**（セル色はコード生成）
- [ ] テーマ13: **アセット不要**（既定フォント使用）
- [ ] 透過・サイズを確認（タイル/背景以外は透過必須）
- [ ] Godot版は各 `Godot/` プロジェクト内にも同じ `assets/` をコピー（res:// から参照するため）

---

# 3D テーマ（`3d/` 配下・PBR/3D用。2Dのピクセルアート指定とは別ルール）

3D比較（`3d/` フォルダ）の素材は **2Dのピクセルアート指定とは別**。以下のルールで生成する。

## 3D共通ルール（2Dと異なる点）
- スタイル: **写実 / PBR向け**（ピクセルアートではない）。
- テクスチャ（アルベド/タイル）は **シームレスにタイリング可能（seamless tileable, no visible seams）**・**透過なし（不透明）**。
- 環境パノラマは **equirectangular（正距円筒, 縦横比 2:1）**。
- いずれも**任意（optional）**。3Dテーマは未配置でも手続き的フォールバックで起動する（配置すると見栄えが上がる）。
- 保存先は各テーマの `3d/<番号>/assets/`（JS系が `../assets/` で参照）。

## 3d/08 PBR + ポストプロセス（保存先: `3d/08/assets/`）
PBR の反射に使う環境マップ。あればスカイ背景＋金属球の映り込みに使用、無ければ RoomEnvironment 等にフォールバック。

### `env_equirect.png` (2048x1024, equirectangular 2:1, 不透明, 任意)
```
Equirectangular 360-degree panorama (2:1 aspect ratio) of a softly lit photo studio / abstract gradient environment for PBR reflection mapping: smooth large light panels on a dark neutral-gray surround, a few brighter soft highlights and gentle color accents (cool blue and warm amber) for interesting metallic reflections, no horizon line text, no people, seamless left-right wrap, high dynamic range look, clean and uncluttered. Output as a 2:1 equirectangular image, opaque, no alpha.
```

> 用途: PBR の environment（IBL）＋背景。three.js は `EquirectangularReflectionMapping`、Babylon は `Texture` の `EQUIRECTANGULAR_MODE`/`HDRCubeTexture`、PlayCanvas は skybox 変換、A-Frame は three の equirect として読み込む。左右がシームレスに繋がること（360°）。

## メモ
- 3Dテーマで**画像が必須のものは現状なし**（T1〜T10 はすべてプリミティブ/コード生成ジオメトリで起動）。上記 `env_equirect.png` は T8 の見栄え向上用の任意素材。
- 将来 GLB（3Dモデル）が要る場合は **text-to-3D（Tripo / Meshy 等）で GLB 生成**し各 `3d/<番号>/assets/` に保存（gptimage2 はテクスチャ/パノラマ向け、メッシュ本体は text-to-3D）。詳細は `docs/3d-engine-theme-research.md`。
