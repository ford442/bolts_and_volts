# Level Format Reference

Complete schema for level JSON files in `public/levels/` and the manifest that lists them.
Verified against the loaders as of this writing:

- `src/components/GameCanvas.tsx` — `normalizeLevelData`, `extractBackgroundLayerConfigs`, `extractDecorConfigs`, `loadDecorLayers`
- `src/lib/levelManifest.ts` — `normalizeLevelManifest`
- `cpp/src/Game.cpp` — `Game::loadLevel`

## How a level is loaded

1. `GameCanvas` fetches `/levels/manifest.json`, then `/levels/<file>` for the selected entry.
2. `normalizeLevelData` validates the JSON and splits it in two:
   - **Core level** (`name`, `description`, `spawn`, `bounds`, `camera`, `platforms`, `goals`) is passed to C++ via `Game::loadLevel`. Only these whitelisted keys reach WASM.
   - **TS-only data** (`backgroundLayers`, `decor`, per-platform `visual`, `author`) stays in the renderer/UI layer. C++ never sees it.
3. Parsing is **lenient**: malformed entries are skipped or defaulted rather than rejected, so a broken level still boots.
4. `validateLevel` (`src/lib/levelValidator.ts`) walks the same JSON and reports everything the loader dropped or defaulted. Each message has the form
   `[level <id> (<file>)] platforms[3].size.y: expected finite number, found string "abc" — entry skipped`.
   Errors go to `console.error`, warnings to `console.warn`; a valid level logs nothing. In dev builds a banner also shows the counts and the first issue. It re-runs on every load, including `R` reload. Absent optional sections (`camera`, `decor`, `backgroundLayers`) are never reported.

## Coordinate system

- World units, not pixels. The viewport is 10 world units wide (height follows aspect ratio).
- **+Y is up**, +X is right. There is no fixed origin; `(0, 0)` is just a convention. Existing levels put the spawn ground near `y = -3`.
- `position` for platforms, goals and decor is the **center** of the rectangle; `size` is full width/height.
- Texture/`uv` rectangles are in **source-image pixels**.

## Top-level fields

| Field | Required | Type | Consumed by | Notes |
|---|---|---|---|---|
| `name` | no | string | C++ + UI | Defaults to `untitled-level` in C++; UI falls back to manifest `name`, then `id`. |
| `description` | no | string | C++ + UI | Falls back to manifest `description`. |
| `author` | no | string | UI only | Shown as "by …". Falls back to manifest `author`. |
| `spawn` | no* | `{x, y}` | C++ | *Without it the player keeps its default position — always set it. |
| `bounds` | no* | `{min:{x,y}, max:{x,y}}` | C++ | Clamps the **camera** (not the player). Both `min` and `max` are required for it to apply. Omit → camera unclamped. |
| `camera` | no | object | C++ | See below. |
| `platforms` | effectively yes | array | C++ + renderer | If missing/empty/all-invalid, a **built-in fallback platform set** is loaded instead. |
| `goals` | no | array | C++ | Touching one completes the level. |
| `backgroundLayers` | no | array | renderer | Default: single `./background.png` layer. |
| `decor` | no | array | renderer | Default: none. |

### `platforms[]`

| Field | Required | Type | Notes |
|---|---|---|---|
| `position` | yes | `{x, y}` | Center. Entry is skipped if missing or non-finite. |
| `size` | yes | `{x, y}` | Width, height. |
| `visual` | no | boolean | `false` = collision only (no sprite drawn). Default `true`. |
| `label` | no | string | Free-form author note; ignored by all loaders (`test-1.json` uses it). |

Invisible collision example: `{ "position": {"x": 8.0, "y": -2.9}, "size": {"x": 0.8, "y": 0.8}, "visual": false }`.
Visual flags are index-aligned with *valid* platforms (invalid entries are dropped before indexing, so skipped entries don't misalign them).

### `goals[]`

Same shape as a platform without `visual`: `position` + `size`, both required. Goals do not need a platform under them. Duplicated goals each trigger independently.

### `camera`

All keys optional; omit the whole object for legacy X-only follow.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `followY` | boolean | `false` | Enable vertical follow. When false the camera Y stays at 0. |
| `verticalDeadzone` | number | `0.75` | Vertical distance the player can move before the camera follows. Clamped to `>= 0`. |
| `lookAheadY` | number | `0.8` | Vertical lead in the direction of travel. |

Wrong-typed keys are dropped individually (e.g. `"followY": "yes"` is ignored).

### `backgroundLayers[]`

Full-screen parallax quads, drawn in listed order (**farthest first**). If the array is missing or yields no valid layers, one default layer is used.

| Key | Required | Type | Default | Notes |
|---|---|---|---|---|
| `image` | yes | string | — | URL relative to `public/`, e.g. `./background.png`. Entries with empty/missing `image` are skipped. |
| `scrollFactorX` | no | number | `0.4` | `0` = fixed to screen, `1` = moves with the world. |
| `scrollFactorY` | no | number | `0.0` | Needs `camera.followY` to have any visible effect. |
| `scale` | no | number | `1.0` | Clamped to `>= 0.01`. |
| `offsetY` | no | number | `0.0` | World units; shifts the layer vertically. |

**Panorama tip:** layers tile horizontally, so use seamless/wrapping images for wide pans. Stack 2–3 layers with increasing `scrollFactorX` (e.g. 0.05 → 0.2 → 0.4) for depth. If an image fails to load, the level load falls back to the default background.

### `decor[]`

Visual-only sprites; no collision, no effect on goals.

| Key | Required | Type | Default | Notes |
|---|---|---|---|---|
| `image` **or** `texture` | yes (one) | string | — | Alias of each other; `image` wins if both set. |
| `position` | yes | `{x, y}` | — | Center, world units. |
| `size` | no | `{x, y}` | derived | If omitted: height `1.0`, width = uv aspect ratio. Each axis is clamped to `0.1–20`. |
| `layer` | no | string | `mid` | `distant` (alias `far`), `mid`, `foreground` (alias `front`). Unknown values → `mid`. Draw order: distant → platforms/mid → … → foreground on top. |
| `parallaxFactor` | no | number | `1.0` | Applies to both axes. Alias: `parallax`. |
| `parallaxX` / `parallaxY` | no | number | `parallaxFactor` | Per-axis override. Aliases: `scrollFactorX` / `scrollFactorY`. |
| `uv` | no | `[x, y, w, h]` | whole image | Pixel rectangle within the source image (spritesheet cutout). Must be 4 finite numbers with `w, h > 0`, else ignored. |
| `offsetY` | no | number | `0.0` | Extra vertical shift in world units. |

Parallax semantics: the item is drawn with camera position × factor. `1.0` moves with the world, `< 1` appears distant (lags), `> 1` appears nearer than the playfield (foreground blur-style motion). A decor item whose texture fails to load is skipped with a console warning.

## Manifest: `public/levels/manifest.json`

```json
{ "levels": [ { "id": "test-1", "file": "test-1.json", "name": "…", "description": "…", "author": "…" } ] }
```

| Field | Required | Notes |
|---|---|---|
| `id` | yes | Unique key used for selection. Entries missing `id` or `file` are skipped. |
| `file` | yes | Filename inside `public/levels/`. |
| `name`, `description`, `author` | no | Fallbacks used when the level JSON lacks the same field (UI-level; the level file's `name`/`description` takes priority). |
| `music` | no | **Parsed but currently unused** — no code reads it yet; music is always `./background-music.mp3`. |

If the manifest is missing/invalid, the game falls back to a single built-in `test-1` entry. The first valid entry is the default level; an unknown id also resolves to the first entry.

## Minimal working example

Collision + spawn + goal; everything else defaults.

```json
{
  "name": "Minimal",
  "spawn": { "x": 0.0, "y": -1.0 },
  "bounds": { "min": { "x": -5.0, "y": -8.0 }, "max": { "x": 25.0, "y": 8.0 } },
  "platforms": [
    { "position": { "x": 0.0, "y": -3.0 }, "size": { "x": 12.0, "y": 0.4 } },
    { "position": { "x": 10.0, "y": -2.0 }, "size": { "x": 3.0, "y": 0.3 } }
  ],
  "goals": [
    { "position": { "x": 10.0, "y": -1.0 }, "size": { "x": 1.0, "y": 1.0 } }
  ]
}
```

Then register it in `manifest.json` (`{ "id": "minimal", "file": "minimal.json" }`).

## Richer example (layers + decor + camera)

Condensed from `public/levels/demo-decor.json` (see that file for the full level):

```json
{
  "name": "Decor Depth Demo",
  "spawn": { "x": -2.0, "y": -1.5 },
  "bounds": { "min": { "x": -6.0, "y": -10.0 }, "max": { "x": 56.0, "y": 10.0 } },
  "camera": { "followY": true, "verticalDeadzone": 0.9, "lookAheadY": 1.0 },
  "backgroundLayers": [
    { "image": "./background.png", "scrollFactorX": 0.08, "scrollFactorY": 0.02, "scale": 1.5, "offsetY": 0.0 },
    { "image": "./background.png", "scrollFactorX": 0.2,  "scrollFactorY": 0.08, "scale": 1.25, "offsetY": -1.2 }
  ],
  "platforms": [
    { "position": { "x": 0.0, "y": -3.0 }, "size": { "x": 12.0, "y": 0.4 } },
    { "position": { "x": 8.0, "y": -2.9 }, "size": { "x": 0.8, "y": 0.8 }, "visual": false }
  ],
  "decor": [
    { "image": "./background.png", "position": { "x": 4.0, "y": 0.4 }, "size": { "x": 6.0, "y": 2.8 },
      "layer": "distant", "parallaxX": 0.18, "parallaxY": 0.08 },
    { "texture": "./platform.png", "position": { "x": 7.9, "y": -2.1 }, "size": { "x": 1.2, "y": 1.2 },
      "layer": "mid", "parallaxFactor": 1.0, "offsetY": -0.1 },
    { "image": "./wazzy_spritesheet.png", "position": { "x": 25.5, "y": -2.2 }, "size": { "x": 1.6, "y": 1.6 },
      "layer": "foreground", "parallaxX": 1.05, "parallaxY": 1.02, "uv": [0, 0, 64, 64] }
  ],
  "goals": [ { "position": { "x": 49.0, "y": 1.6 }, "size": { "x": 1.5, "y": 1.2 } } ]
}
```

`public/levels/test-1.json` is the reference for a pure-collision level: it uses only `name`, `description`, `spawn`, `bounds`, `platforms` (with `label`) and `goals`.

## Authoring checklist for a new map

1. Put images in `public/` and reference them as `./file.png`.
2. Set `bounds` a bit wider than your platforms so the camera clamps sensibly.
3. For tall levels, enable `camera.followY` and give background layers a small non-zero `scrollFactorY`.
4. Add the file to `manifest.json`, run `npm run dev`, and pick it from the level dropdown (`R` reloads the level).
5. Check the browser console for `[level …]` errors/warnings after each load (field-path messages from the validator, plus `Failed to load decor texture` for images that don't exist).
