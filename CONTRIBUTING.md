# Contributing to Web Game Engine Benchmark

Thanks for your interest in contributing!

## How to Contribute

### Reporting Issues

Report bugs or suggestions via [GitHub Issues](https://github.com/yunbow/web-game-engine-benchmark/issues).
When reporting a problem with a demo, please include the theme number, the
engine name, and the browser you used.

### Pull Requests

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Commit with a descriptive message
5. Open a pull request

### What to Contribute

| Area | What We Need | Guidelines |
|---|---|---|
| Existing implementations (`demo/2d/`, `demo/3d/`) | Bug fixes, fixing divergence from `SPEC.md` | `SPEC.md` is the single source of truth for each theme. Any change to numeric values should be discussed in an Issue first. |
| New engine implementations | New engines added to an existing theme | Must fully comply with the theme's `SPEC.md`: common HUD, `+`/`-` key load control, fallback when images are missing, deterministic generation (no `Math.random`), physics implemented from scratch where possible. Structure as three files: `index.html`, `game.js`, `README.md`. |
| New theme proposals | New benchmark themes | Must follow the design principle of "isolating exactly one load axis to compare." Discuss in an Issue first. |
| `demo/*/_bench/` | Improvements to the measurement harness | |
| `docs/i18n/` | Translations | See the Translation Guide below. |

### Development Setup

No Node.js required. Just start any HTTP server, e.g.:

```
cd demo && python -m http.server 8000
```

Opening files directly via `file://` will not work due to CORS restrictions.
Chrome is recommended for verifying your changes.

### Translation Guide

- The English files at the repository root are the source of truth.
- Translations live under `docs/i18n/{lang}/`, mirroring the structure of the
  English version.
- Supported languages: `ja` (Japanese), `zh-CN` (Chinese), `ko` (Korean),
  `es` (Spanish).
- Keep technical terms, code blocks, URLs, and file paths in English.
- End each file with a `Languages:` footer, where the current language is
  shown as plain text without a link.

## Code of Conduct

Be respectful, constructive, and inclusive. We welcome contributors of all
experience levels.

## Questions?

Open an Issue or start a Discussion on GitHub.

---

Languages: English | [日本語](docs/i18n/ja/CONTRIBUTING.md)
