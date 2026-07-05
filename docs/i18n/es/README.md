# Web Game Engine Benchmark

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../../../LICENSE)

Una colección de benchmarks que implementa mini-juegos con la misma especificación en múltiples motores de juegos web / bibliotecas 3D de código abierto y los compara **lado a lado**.

- **2D: 13 temas × 7 motores = 91 implementaciones** (Phaser 4 / PixiJS v8 / Babylon.js / LittleJS / three.js / KAPLAY / A-Frame)
- **3D: 10 temas × 4 bibliotecas = 40 implementaciones** (three.js / Babylon.js / PlayCanvas / A-Frame)

Cada tema está diseñado para aislar exactamente un "eje de carga" que se desea comparar (por ejemplo, rendimiento de renderizado / física de cuerpos rígidos / partículas GPU / ordenamiento por profundidad / transferencia dinámica de texturas, ...). Todas las implementaciones comparten la misma especificación (`SPEC.md`), los mismos controles y el mismo HUD, de modo que puedes aumentar o disminuir la carga con las teclas `+` / `-` y comparar el comportamiento y los FPS.

## 🎮 Juega las Demos (GitHub Pages)

**▶ Portal de demos: <https://yunbow.github.io/web-game-engine-benchmark/demo/>**

El punto de entrada a las 131 implementaciones. Elige un tema × motor desde las pestañas 2D/3D para iniciarlo.

- Ejemplo de URL de una demo individual: [`demo/2d/01/Phaser4/`](https://yunbow.github.io/web-game-engine-benchmark/demo/2d/01/Phaser4/index.html) (shooter bullet-hell, versión Phaser 4)
- Medición automática de FPS: [arnés de benchmark 2D](https://yunbow.github.io/web-game-engine-benchmark/demo/2d/_bench/index.html) / [arnés de benchmark 3D](https://yunbow.github.io/web-game-engine-benchmark/demo/3d/_bench/index.html)

> Incluso sin los recursos de imagen colocados, todos los juegos se inician con una alternativa de forma en color sólido.

## Lista de Temas

### 2D (13 temas × 7 motores)

| # | Género | Eje principal de comparación (carga aumentada/disminuida con `+`/`-`) |
|---|---|---|
| 01 | Shooter bullet-hell (shmup vertical) | Rendimiento de renderizado (volumen de balas/enemigos) |
| 02 | Survivor top-down | Actualización de gran cantidad de entidades + colisión personalizada |
| 03 | Exploración RPG top-down | Renderizado de mapas grandes + culling del viewport |
| 04 | Breakout (multi-bola) | Resolución de colisiones para muchas bolas × muchos bloques |
| 05 | Acción de desplazamiento lateral | Renderizado de mapa ancho + física de gravedad/AABB |
| 06 | Tower defense | Búsqueda de rutas (A*) + seguimiento de gran cantidad de unidades |
| 07 | Puzzle de física (física de proyectiles) | Integración del motor de física de cuerpos rígidos y escalado del número de cuerpos rígidos |
| 08 | Partículas/efectos mágicos | Mecanismo de GPU/partículas + mezcla aditiva |
| 09 | Ciudad/granja isométrica | Ordenamiento por profundidad (z-order) + renderizado de profundidad de tiles |
| 10 | Puzzle match-3 | Lógica intensiva, renderizado ligero × muchos tweens |
| 11 | Iluminación/sombras dinámicas 2D | Múltiples luces + composición de mapas de luz + generación de sombras |
| 12 | Arena que cae/autómata celular | Actualización de celdas de la cuadrícula + reescritura de la textura completa en cada fotograma |
| 13 | Renderizado masivo de texto/UI | Muchos elementos de texto dinámicos + re-renderizado de glifos |

### 3D (10 temas × 4 bibliotecas)

| # | Tema | Eje principal de comparación (`+`/`-`) |
|---|---|---|
| 01 | Campo de asteroides instanciados (STG 3D) | Renderizado masivo instanciado de una sola malla (hasta 50,000) |
| 02 | Colapso de torre de cajas (física de cuerpos rígidos 3D) | Integración del motor de física (Rapier/Havok/ammo) + número de cuerpos rígidos |
| 03 | Horda de personajes con skinning (glTF) | Rendimiento de reproducción de skinning/animación esquelética |
| 04 | Partículas GPU (magia/fuente) | Rendimiento del mecanismo de partículas + brillo aditivo (hasta 500,000) |
| 05 | Culling/LOD de terreno de área amplia | Frustum culling + LOD por distancia (distancia de dibujado) |
| 06 | Iluminación de sombras dinámicas | Número de mapas de sombras en tiempo real |
| 07 | Regeneración de chunks de voxels | Reconstrucción/reenvío del búfer de vértices en cada fotograma |
| 08 | PBR + postprocesado (Bloom) | Sombreado PBR + composición de Bloom |
| 09 | Multitud de navegación 3D (A*) | Búsqueda de rutas A* en cuadrícula + seguimiento de gran cantidad de agentes |
| 10 | Raycasting masivo (LIDAR) | Intersección rayo-malla en cada fotograma |

Para eliminar las diferencias de backend, 3D **fija todas las bibliotecas a WebGL2** (sin WebGPU).

## 📊 Medición de Rendimiento (`_bench`)

`demo/2d/_bench/` y `demo/3d/_bench/` incluyen un **arnés de medición automática de FPS**. Cada juego se inicia secuencialmente en un iframe, y el arnés cuenta directamente `requestAnimationFrame` dentro del iframe para medir los FPS reales (el juego en sí no se modifica y la medición no depende de la visualización del HUD).

- Control de carga: envía `+` mediante eventos de teclado sintéticos, aplicando niveles de carga `0 / 10 / 25` de manera uniforme en todos los motores
- Ciclo de medición: espera de inicio de 3.5s → estabilización de 1.5s → muestreo de 8s
- CSV de salida: `theme, engine, level, fps_avg, fps_1pct_low, objects, transferKB, initMs, frames, error`
  - `fps_1pct_low` = el 1% bajo calculado a partir del percentil 99 del tiempo de fotograma (un indicador de tartamudeo)
  - `transferKB` / `initMs` = tamaño de transferencia inicial / tiempo hasta DOMContentLoaded

Ejecuta la medición abriendo el [arnés 2D](https://yunbow.github.io/web-game-engine-benchmark/demo/2d/_bench/index.html) / [arnés 3D](https://yunbow.github.io/web-game-engine-benchmark/demo/3d/_bench/index.html) en tu navegador (**se recomienda Chrome, mantén la pestaña en primer plano durante la medición** — las pestañas en segundo plano limitan el rAF e invalidan los resultados). Los resultados se descargan como un CSV.

### Resultados de la Medición

> 📝 Próximamente — después de un ciclo completo de mediciones en todos los temas/motores en un entorno unificado, se publicará aquí una tabla de resultados de FPS medidos (con el entorno de medición indicado).

## Ejecución Local

Abrir directamente vía `file://` no funciona para la carga de imágenes (CORS). Sirve `demo/` como raíz con un servidor HTTP:

```bash
cd demo
python -m http.server 8000
# → http://localhost:8000/            (portal)
# → http://localhost:8000/2d/01/Phaser4/   (demo individual)
```

Para ejecutar el arnés de benchmark localmente, sirve `demo/2d/` como raíz para 2D o `demo/3d/` como raíz para 3D, y luego abre `_bench/`.

## Estructura de Directorios

```
├─ demo/
│  ├─ index.html        … Portal de demos (punto de entrada a las 131 implementaciones)
│  ├─ 2d/
│  │  ├─ 01/ … 13/      … Temas 2D (cada tema sigue la misma estructura)
│  │  │  ├─ SPEC.md     … Especificación compartida por todos los motores (fuente única de verdad para números/reglas)
│  │  │  ├─ assets/     … Recursos de imagen (generados con gptimage2)
│  │  │  ├─ Phaser4/    … index.html + game.js + README.md
│  │  │  ├─ PixiJS/  Babylon.js/  LittleJS/  three.js/  KAPLAY/  A-Frame/
│  │  └─ _bench/        … Arnés de medición automática de FPS 2D
│  └─ 3d/
│     ├─ 01/ … 10/      … Temas 3D (three.js / Babylon.js / PlayCanvas / A-Frame)
│     └─ _bench/        … Arnés de medición automática de FPS 3D
├─ docs/                … Notas de investigación sobre la selección de motores y el diseño de temas
│  ├─ IMAGE_PROMPTS.md  … Prompts de generación de recursos de imagen (para gptimage2)
│  └─ i18n/             … Versiones localizadas del README (ja / zh-CN / ko / es)
└─ README.md
```

El `README.md` de cada carpeta de motor documenta **cómo ejecutarlo, la versión utilizada, notas de implementación e impresiones sobre la codificación asistida por IA**.

## Especificación Común Seguida por Todas las Implementaciones

- **`SPEC.md` es la fuente única de verdad**: valores numéricos como velocidad, HP, límites de generación y método de detección de colisiones son idénticos en todos los motores para el mismo tema
- **HUD común**: la esquina superior izquierda de la pantalla muestra `FPS` (media móvil) / `Objects` / `Score` / `HP` / la configuración de carga actual
- **La carga se aumenta/disminuye con las teclas `+` / `-`** (el eje de carga principal difiere según el tema)
- **Cuando faltan las imágenes, el juego siempre se inicia con una alternativa de forma en color sólido**
- **Los motores de física se implementan desde cero en principio** (las excepciones son 2d/07 y 3d/02, donde la integración del motor de física en sí es el punto de comparación)
- **Generación determinista (no se usa `Math.random`)** — permite realizar benchmarks desatendidos mediante autoplay

## Lecciones Aprendidas (Destacados)

### Técnicas de Rendimiento Comunes que Dieron Resultado en Todos los Motores

- **Detección de colisión de círculos personalizada (comparación de distancia al cuadrado)** — la técnica decisiva para la detección masiva de colisiones
- **Reutilización de object pool** (cero asignación/liberación) — los juegos del género survivor alcanzan de cientos a miles de entidades
- **Renderizar solo el área visible (culling)** — comprime el renderizado real de un mapa de 100×100 a ~600 tiles
- **AABB con separación de ejes + reflexión por cara** — maneja la colisión de multi-bola y el terreno de desplazamiento lateral de forma estable sin un motor de física
- En todos los casos, este es el tipo de optimización que una IA tiende a omitir a menos que se le indique explícitamente que la incluya

### Compatibilidad con Codificación con IA (más ★ = más fácil de escribir)

| Motor | Compatibilidad | Puntos clave |
|---|---|---|
| **Phaser 4** | ★★★★★ | API estable; el conocimiento de Phaser 3 es aplicable. La optimización a gran escala requiere instrucciones explícitas para usar pooling / evitar el motor de física |
| **PixiJS v8** | ★★★★☆ | La lógica es efectivamente JS plano. La mayor trampa son los **cambios disruptivos de v8** (`await app.init()`, `app.canvas`, la nueva API de Graphics) — especificar explícitamente v8 es la clave del éxito |
| **LittleJS** | ★★★☆☆ | CDN único; fácil de comprender en su totalidad. Presta atención a las confusiones entre ESM/classic, el eje Y apuntando hacia arriba y la superposición entre la capa WebGL y el HUD |
| **Babylon.js** | ★★★☆☆ | La **configuración inicial del sistema de coordenadas** (Y hacia arriba / origen en el centro) al escribir 2D con un motor 3D es la parte más difícil. El batching de SpriteManager maneja bien grandes cantidades de sprites |

Consulta el `README.md` de cada carpeta de motor para conocer las impresiones sobre three.js / KAPLAY / A-Frame / PlayCanvas.

## Sobre los Recursos de Imagen

Los recursos se crean introduciendo los prompts de [`IMAGE_PROMPTS.md`](../../IMAGE_PROMPTS.md) en una IA de generación de imágenes (gptimage2) y colocándolos en la carpeta `assets/` de cada tema. Todos los juegos se inician con una alternativa de forma incluso sin imágenes, de modo que la comparación de lógica puede realizarse primero, con las imágenes incorporadas más adelante.

## Notas de Investigación Relacionadas

- [`docs/game-engine-oss-codex-research.md`](../../game-engine-oss-codex-research.md) — Investigación preliminar detrás de la selección de motores (comparación de licencias, compatibilidad con IA y rendimiento)
- [`docs/3d-engine-theme-research.md`](../../3d-engine-theme-research.md) — Investigación sobre bibliotecas candidatas y temas de comparación para el benchmark 3D

## Licencia

[MIT](../../../LICENSE)

## Contribuciones

Consulta [CONTRIBUTING.md](../../../CONTRIBUTING.md) para más detalles.

---

Languages: [English](../../../README.md) | [日本語](../ja/README.md) | [简体中文](../zh-CN/README.md) | [한국어](../ko/README.md) | Español
