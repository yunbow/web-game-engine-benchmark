# Web Game Engine Benchmark

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../../../LICENSE)

여러 OSS 웹 게임 엔진 / 3D 라이브러리에 **동일 사양의 미니게임을 구현하여 나란히 비교**하는 벤치마크 모음집.

- **2D: 13개 테마 × 7개 엔진 = 91개 구현** (Phaser 4 / PixiJS v8 / Babylon.js / LittleJS / three.js / KAPLAY / A-Frame)
- **3D: 10개 테마 × 4개 라이브러리 = 40개 구현** (three.js / Babylon.js / PlayCanvas / A-Frame)

각 테마는 비교하고 싶은 "부하 축" 하나만을 분리하도록 설계되어 있다 (예: 렌더링 처리량 / 강체 물리 / GPU 파티클 / 깊이 정렬 / 동적 텍스처 전송 등). 모든 구현은 동일한 사양(`SPEC.md`), 동일한 조작법, 동일한 HUD를 공유하므로 `+` / `-` 키로 부하를 늘리거나 줄이며 동작과 FPS를 비교할 수 있다.

## 🎮 데모 실행하기 (GitHub Pages)

**▶ 데모 포털: <https://yunbow.github.io/web-game-engine-benchmark/demo/>**

전체 131개 구현으로 가는 입구. 2D/3D 탭에서 테마 × 엔진을 선택해 실행할 수 있다.

- 개별 데모 URL 예시: [`demo/2d/01/Phaser4/`](https://yunbow.github.io/web-game-engine-benchmark/demo/2d/01/Phaser4/index.html) (탄막 슈팅 게임, Phaser 4 버전)
- 자동 FPS 측정: [2D 벤치 하니스](https://yunbow.github.io/web-game-engine-benchmark/demo/2d/_bench/index.html) / [3D 벤치 하니스](https://yunbow.github.io/web-game-engine-benchmark/demo/3d/_bench/index.html)

> 이미지 에셋이 배치되어 있지 않아도 모든 게임은 단색 도형 폴백으로 실행된다.

## 테마 목록

### 2D (13개 테마 × 7개 엔진)

| # | 장르 | 주요 비교 축 (`+`/`-`로 증감하는 부하) |
|---|---|---|
| 01 | 탄막 슈팅 (종스크롤 슈팅) | 렌더링 처리량 (탄/적의 물량) |
| 02 | 탑다운 서바이버 | 대량 엔티티 갱신 + 자체 충돌 처리 |
| 03 | 탑다운 RPG 탐험 | 대형 맵 렌더링 + 뷰포트 컬링 |
| 04 | 벽돌깨기 (멀티볼) | 다수의 공 × 다수의 블록 충돌 처리 |
| 05 | 횡스크롤 액션 | 넓은 맵 렌더링 + 중력/AABB 물리 |
| 06 | 타워 디펜스 | 경로 탐색(A*) + 대량 유닛 추적 |
| 07 | 물리 퍼즐 (발사체 물리) | 강체 물리 엔진 통합과 강체 수 스케일링 |
| 08 | 파티클/마법 이펙트 | GPU/파티클 메커니즘 + 가산 블렌딩 |
| 09 | 아이소메트릭 도시/농장 | 깊이 정렬(z-order) + 타일 깊이 렌더링 |
| 10 | 매치3 퍼즐 | 로직 중심, 가벼운 렌더링 × 다수의 트윈 |
| 11 | 2D 동적 조명/그림자 | 다중 광원 + 라이트맵 합성 + 그림자 생성 |
| 12 | 폴링 샌드/셀룰러 오토마타 | 격자 셀 갱신 + 매 프레임 전체 텍스처 재작성 |
| 13 | 대량 텍스트/UI 렌더링 | 다수의 동적 텍스트 요소 + 글리프 재렌더링 |

### 3D (10개 테마 × 4개 라이브러리)

| # | 테마 | 주요 비교 축 (`+`/`-`) |
|---|---|---|
| 01 | 인스턴스 소행성 필드 (3D STG) | 단일 메시의 대량 인스턴스 렌더링 (최대 50,000) |
| 02 | 박스 타워 붕괴 (3D 강체 물리) | 물리 엔진 통합(Rapier/Havok/ammo) + 강체 수 |
| 03 | 스킨드 캐릭터 무리 (glTF) | 스키닝/스켈레탈 애니메이션 재생 처리량 |
| 04 | GPU 파티클 (마법/분수) | 파티클 메커니즘 처리량 + 가산 발광 (최대 50만) |
| 05 | 광역 지형 컬링/LOD | 절두체 컬링 + 거리 LOD (드로우 디스턴스) |
| 06 | 동적 그림자 조명 | 실시간 그림자 맵 개수 |
| 07 | 복셀 청크 재생성 | 매 프레임 버텍스 버퍼 재구축/재업로드 |
| 08 | PBR + 포스트 프로세싱 (Bloom) | PBR 셰이딩 + Bloom 합성 |
| 09 | 3D 내비게이션 군중 (A*) | 그리드 A* 경로 탐색 + 대량 에이전트 추적 |
| 10 | 대량 레이캐스팅 (LIDAR) | 매 프레임 광선-메시 교차 |

백엔드 차이를 배제하기 위해 3D는 **모든 라이브러리를 WebGL2로 고정**한다 (WebGPU 미사용).

## 📊 성능 측정 (`_bench`)

`demo/2d/_bench/` 및 `demo/3d/_bench/`에는 **자동 FPS 측정 하니스**가 포함되어 있다. 각 게임을 iframe 안에서 순차적으로 실행하고, iframe 내부의 `requestAnimationFrame`을 하니스가 직접 카운트하여 실제 FPS를 측정한다 (게임 자체는 수정되지 않으며, 측정은 HUD 표시에 의존하지 않는다).

- 부하 제어: 합성 키 이벤트로 `+`를 전송하여, 부하 레벨 `0 / 10 / 25`를 모든 엔진에 동일하게 적용
- 측정 주기: 시작 대기 3.5초 → 안정화 1.5초 → 샘플링 8초
- 출력 CSV: `theme, engine, level, fps_avg, fps_1pct_low, objects, transferKB, initMs, frames, error`
  - `fps_1pct_low` = 프레임 시간의 99번째 백분위수로 산출한 1% 로우 (끊김 지표)
  - `transferKB` / `initMs` = 초기 전송 크기 / DOMContentLoaded까지의 시간

측정은 브라우저에서 [2D 하니스](https://yunbow.github.io/web-game-engine-benchmark/demo/2d/_bench/index.html) / [3D 하니스](https://yunbow.github.io/web-game-engine-benchmark/demo/3d/_bench/index.html)를 열어 실행한다 (**Chrome 권장, 측정 중에는 탭을 전면에 유지** — 백그라운드 탭은 rAF가 제한되어 결과가 무효화된다). 결과는 CSV로 다운로드된다.

### 측정 결과

> 📝 준비 중 — 통일된 환경에서 모든 테마/엔진에 대한 전체 측정을 완료한 후, 측정된 FPS 결과 표(측정 환경 명시)를 여기에 게재할 예정이다.

## 로컬에서 실행하기

`file://`로 직접 여는 방식은 이미지 로딩(CORS) 때문에 동작하지 않는다. `demo/`를 루트로 하는 HTTP 서버를 실행한다:

```bash
cd demo
python -m http.server 8000
# → http://localhost:8000/            (포털)
# → http://localhost:8000/2d/01/Phaser4/   (개별 데모)
```

벤치 하니스를 로컬에서 실행하려면, 2D는 `demo/2d/`를, 3D는 `demo/3d/`를 루트로 서빙한 뒤 `_bench/`를 열면 된다.

## 디렉터리 구조

```
├─ demo/
│  ├─ index.html        … 데모 포털 (전체 131개 구현으로 가는 입구)
│  ├─ 2d/
│  │  ├─ 01/ … 13/      … 2D 테마 (각 테마는 동일한 구조를 따름)
│  │  │  ├─ SPEC.md     … 모든 엔진이 공유하는 사양 (수치/규칙의 유일한 기준)
│  │  │  ├─ assets/     … 이미지 에셋 (gptimage2로 생성)
│  │  │  ├─ Phaser4/    … index.html + game.js + README.md
│  │  │  ├─ PixiJS/  Babylon.js/  LittleJS/  three.js/  KAPLAY/  A-Frame/
│  │  └─ _bench/        … 2D 자동 FPS 측정 하니스
│  └─ 3d/
│     ├─ 01/ … 10/      … 3D 테마 (three.js / Babylon.js / PlayCanvas / A-Frame)
│     └─ _bench/        … 3D 자동 FPS 측정 하니스
├─ docs/                … 엔진 선정 및 테마 설계에 관한 조사 노트
│  ├─ IMAGE_PROMPTS.md  … 이미지 에셋 생성 프롬프트 모음 (gptimage2용)
│  └─ i18n/             … README 다국어 버전 (ja / zh-CN / ko / es)
└─ README.md
```

각 엔진 폴더의 `README.md`에는 **실행 방법, 사용 버전, 구현 노트, AI 지원 코딩에 대한 소감**이 기록되어 있다.

## 모든 구현이 따르는 공통 사양

- **`SPEC.md`가 유일한 기준**: 속도, HP, 스폰 상한, 충돌 판정 방식 등의 수치는 동일 테마의 모든 엔진에서 완전히 일치한다
- **공통 HUD**: 화면 좌측 상단에 `FPS`(이동 평균) / `Objects` / `Score` / `HP` / 현재 부하 설정값을 표시
- **`+` / `-` 키로 부하 증감** (테마별로 주된 부하 축은 다르다)
- **이미지가 없을 때는 반드시 단색 도형 폴백으로 실행됨**
- **물리 엔진은 원칙적으로 직접 구현** (예외는 2d/07과 3d/02로, 물리 엔진 통합 자체가 비교 대상)
- **결정론적 생성 (`Math.random` 미사용)** — 오토플레이를 통한 무인 벤치마크가 가능

## 배운 점 (요약)

### 모든 엔진에서 효과가 있었던 공통 성능 설계 기법

- **자체 원 판정 (거리 제곱 비교)** — 대량 충돌 판정의 결정적 기법
- **오브젝트 풀 재사용** (생성/파괴 제로화) — 서바이버 장르에서 수백~수천 개체에 도달
- **가시 영역만 렌더링 (컬링)** — 100×100 맵의 실제 렌더링을 약 600개 타일로 압축
- **축 분리 AABB + 면별 반사** — 물리 엔진 없이도 멀티볼 충돌과 횡스크롤 지형을 안정적으로 처리
- 모든 경우에서 이는 AI에게 명시적으로 지시하지 않으면 생략되기 쉬운 최적화 기법이었다

### AI 코딩 호환성 (★가 많을수록 작성하기 쉬움)

| 엔진 | 호환성 | 핵심 포인트 |
|---|---|---|
| **Phaser 4** | ★★★★★ | API가 안정적이며 Phaser 3 지식이 그대로 통용됨. 대규모 최적화를 위해서는 풀링 사용 / 물리 엔진 미사용을 명시적으로 지시해야 함 |
| **PixiJS v8** | ★★★★☆ | 로직은 사실상 순수 JS와 다름없음. 가장 큰 함정은 **v8의 호환성 파괴 변경**(`await app.init()`, `app.canvas`, 새로운 Graphics API)이며, v8을 명시적으로 지정하는 것이 성공의 핵심 |
| **LittleJS** | ★★★☆☆ | 단일 CDN으로 전체를 파악하기 쉬움. ESM/classic 혼동, Y축이 위를 향하는 점, WebGL 레이어와 HUD의 겹침에 주의 |
| **Babylon.js** | ★★★☆☆ | 3D 엔진으로 2D를 작성할 때 **초기 좌표계 설정**(Y-up / 원점 중앙)이 가장 어려운 부분. SpriteManager의 배칭은 대량 스프라이트 처리에 강함 |

three.js / KAPLAY / A-Frame / PlayCanvas에 대한 소감은 각 엔진 폴더의 `README.md`를 참조.

## 이미지 에셋에 대하여

에셋은 [`IMAGE_PROMPTS.md`](../../IMAGE_PROMPTS.md)의 프롬프트를 이미지 생성 AI(gptimage2)에 입력하여 제작하고, 각 테마의 `assets/` 폴더에 배치한다. 이미지가 없어도 모든 게임은 도형 폴백으로 실행되므로, 로직 비교를 먼저 하고 이미지는 나중에 교체할 수 있다.

## 관련 조사 노트

- [`docs/game-engine-oss-codex-research.md`](../../game-engine-oss-codex-research.md) — 엔진 선정의 사전 조사 (라이선스, AI 호환성, 성능 비교)
- [`docs/3d-engine-theme-research.md`](../../3d-engine-theme-research.md) — 3D 벤치마크용 라이브러리 후보 및 비교 테마 조사

## 라이선스

[MIT](../../../LICENSE)

## 기여

자세한 내용은 [CONTRIBUTING.md](../../../CONTRIBUTING.md)를 참조.

---

Languages: [English](../../../README.md) | [日本語](../ja/README.md) | [简体中文](../zh-CN/README.md) | 한국어 | [Español](../es/README.md)
