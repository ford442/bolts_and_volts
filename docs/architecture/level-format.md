# Level Format Reference

Complete schema for level JSON files in `public/levels/` and the manifest that lists them.
Verified against the loaders as of this writing:

- `src/lib/levelData.ts` — `normalizeLevelData`, `extractBackgroundLayerConfigs`, `extractDecorConfigs`
- `src/game/levelAssets.ts` — `loadBackgroundLayers`, `loadDecorLayers`
- `src/lib/levelManifest.ts` — `normalizeLevelManifest`
- `cpp/src/Game.cpp` — `Game::loadLevel` (copies the fields into a `LevelSpec` for `Simulation::loadLevel`, `cpp/src/sim/`)

## How a level is loaded

1. `GameCanvas` fetches `/levels/manifest.json`, then `/levels/<file>` for the selected entry.
2. `normalizeLevelData` validates the JSON and splits it in two:
   - **Core level** (`name`, `description`, `spawn`, `bounds`, `camera`, `platforms` (with `oneWay` / `patrol`), `goals`, `checkpoints`, `hazards`, `payload`, `terminals`, `launchers`) is passed to C++ via `Game::loadLevel`. Only these whitelisted keys reach WASM, as plain numbers (C++ never parses JSON).
   - **TS-only data** (`backgroundLayers`, `decor`, per-platform `visual`, `author`) stays in the renderer/UI layer. C++ never sees it.
3. Parsing is **lenient**: malformed entries are skipped or defaulted rather than rejected, so a broken level still boots.
4. `validateLevel` (`src/lib/levelValidator.ts`) walks the same JSON and reports everything the loader dropped or defaulted. Each message has the form
   `[level <id> (<file>)] platforms[3].size.y: expected finite number, found string "abc" — entry skipped`.
   Errors go to `console.error`, warnings to `console.warn`; a valid level logs nothing. In dev builds a banner also shows the counts and the first issue. It re-runs on every load, including `R` reload. Absent optional sections (`camera`, `decor`, `backgroundLayers`) are never reported.

## Coordinate system

- World units, not pixels. The viewport is 10 world units wide (height follows aspect ratio).
- **+Y is up**, +X is right. There is no fixed origin; `(0, 0)` is just a convention. Existing levels put the spawn ground near `y = -3`.
- `position` for platforms, goals, hazards, the payload, terminals, launchers and decor is the **center** of the rectangle; `size` is full width/height.
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
| `goals` | no | array | C++ | Touching one completes the level (while carrying the `payload`, if the level has one). |
| `checkpoints` | no | array | C++ | Entering one makes it the respawn point. |
| `hazards` | no | array | C++ + renderer | Touching one respawns the player. Optional patrol. |
| `payload` | no | object | C++ + renderer | One pickup. When present, goals only complete while it is carried. |
| `terminals` | no | array | C++ + renderer | Volts + `E` disables a hazard. |
| `launchers` | no | array | C++ + renderer | Entering one sets the player's velocity. |
| `backgroundLayers` | no | array | renderer | Parallax and/or world-space painted layers. Default: single `./background.png` parallax layer. |
| `decor` | no | array | renderer | Default: none. |

### `platforms[]`

| Field | Required | Type | Notes |
|---|---|---|---|
| `position` | yes | `{x, y}` | Center. Entry is skipped if missing or non-finite. |
| `size` | yes | `{x, y}` | Width, height. |
| `visual` | no | boolean | `false` = collision only (no sprite drawn). Default `true`. |
| `oneWay` | no | boolean | `true` = only the top face is solid (see below). Default `false`, a solid box. |
| `patrol` | no | `{x0, y0, x1, y1, speed}` | Makes it a moving platform (see below). All five must be finite numbers or the platform is static. |
| `label` | no | string | Free-form author note; ignored by all loaders (`test-1.json` uses it). |

Invisible collision example: `{ "position": {"x": 8.0, "y": -2.9}, "size": {"x": 0.8, "y": 0.8}, "visual": false }`.
Visual flags are index-aligned with *valid* platforms (invalid entries are dropped before indexing, so skipped entries don't misalign them).

Platforms are resolved in index order (among the valid entries) when the player overlaps more than one, and that includes moving ones: a mover is tested every tick at its current position, in its index slot.

#### One-way platforms (`"oneWay": true`)

Only the **top face** is solid, and only for a player whose feet were at or above that top before the move and who is not rising (`velocity.y <= 0`). A jump from below passes up through it; if the jump does not clear the top, the player falls back down through it too. It has no sides (walking into one at body height does nothing) and no underside. Landed on, it is an ordinary floor: grounded, coyote time when walking off, `Landed` on the tick of contact. There is no drop-through. Drawn with the platform texture at 60% opacity.

#### Moving platforms (`patrol`)

`patrol: { x0, y0, x1, y1, speed }` moves the platform's centre back and forth between `(x0, y0)` and `(x1, y1)` at a constant `speed` in units/s, turning at each end. The path may be horizontal, vertical or diagonal. It starts at the point of the path nearest its `position` (so put `position` on the path). A negative `speed` uses its absolute value; `speed: 0` or a path with no length leaves it static. It can also be `oneWay`. It is solid like any platform and ignores other platforms (it follows its path through them, which is how a tram can slide into a dock).

- **Riding:** a player standing on it moves with it, in the same tick, so they are never inside it or a tick behind. A rider whose feet also rest on a static platform (a dock the mover slid into) is carried up and down but not dragged sideways. Jumping off keeps only the player's own velocity.
- **Walls and ceilings:** a rider carried into a static platform stops at its surface; the mover carries on. Nothing is crushed: a solid mover that ends a move still overlapping the player (it pushed them into a wall, or squeezed them against the floor) lets them through until they no longer overlap.
- **Pushing:** a solid mover that runs into a player who is not riding it pushes them out along its motion (rising: onto its top). A one-way mover only picks up a player whose feet were at or above its top.
- Fast movers are substepped by the same rule as long falls, so neither the rider nor the mover can skip across a thin platform.
- State lasts until the next level load: a respawn does not reset a mover's position. Drawn with the platform texture at its current position.

### `launchers[]`

| Field | Required | Type | Notes |
|---|---|---|---|
| `position` | yes | `{x, y}` | Center. |
| `size` | yes | `{x, y}` | Width, height. |
| `velocity` | yes | `{x, y}` | Units/s. A missing or non-finite `velocity` skips the entry. |
| `label` | no | string | Author note; ignored. |

A trigger, not a solid (overlap rule as hazards: touching edges do not count). The first tick the player overlaps it, the player's velocity is **replaced** by `velocity`, both axes, and the sim emits one `Launched` (with the launcher's index; it plays the `jump` sound). It re-arms once the player has left. Both characters. A launch leaves the ground like a jump, without the jump cut (letting go of a held jump key does not shorten it) and without coyote time.

The replacement is total: a launch during a ground pound swaps the pound's downward speed for `velocity` and does **not** end the pound (it stays active until it lands or times out); during a hover it keeps the hover's low gravity. Horizontal speed above the character's run speed is clamped as soon as a direction is held, so steer-heavy launches should be mostly vertical. A pad sitting on a floor fires instead of a landing.

Launchers are checked after collision (so a pad fires from a resolved position) and before hazards: a launcher and a hazard in the same box launch, then the hazard still respawns the player. A respawn onto a launcher does not fire it until the player has left and come back. For height: a launch of `vy` rises about `vy² / 49` units (so 19 u/s clears ~7.3), the same gravity as a jump minus its takeoff tick. Drawn as an amber quad.

### `goals[]`

Same shape as a platform without `visual`: `position` + `size`, both required. Goals do not need a platform under them. Duplicated goals each trigger independently.

### `checkpoints[]`

Same shape as a goal: `position` + `size`, both required, plus an optional `label`. A checkpoint is a trigger, not a solid, and has no art yet (use `decor` to mark one). The first tick the player's box **overlaps** it (touching edges do not count), its centre becomes the respawn point and the sim emits one `CheckpointReached` for it. It re-arms once the player has left, so standing in one, or being respawned onto one, does not repeat; entering the same one again later does. The **latest** one entered is the respawn point, whatever its index, and `loadLevel` always starts a level with none (respawn = `spawn`).

Respawn puts the player at the checkpoint's **centre**, at rest, so set `position.y` where the player's centre should stand (a resting player is half its height, 0.4, above the platform top), not on the floor. Everything else about a respawn is unchanged: the payload goes back to its pad (so a checkpoint past the pad means walking back for the package), hazards, terminals and goals keep their state.

Checkpoints are indexed by position among the **valid** entries, like hazards. The index is what the shell saves per level (see *Progress*), so reordering or removing checkpoints in a level makes an old saved index point at a different one, or at none (then the game starts that level from the spawn).

### `hazards[]`

| Field | Required | Type | Notes |
|---|---|---|---|
| `position` | yes | `{x, y}` | Center. Entry is skipped if missing or non-finite. |
| `size` | yes | `{x, y}` | Width, height. |
| `patrol` | no | `{x0, x1, speed}` | Moves along x between `x0` and `x1` at a constant `speed` (units/s), turning at each end. All three must be finite numbers or the hazard is static. `x0 > x1` is swapped, a negative `speed` uses its absolute value, `position.x` outside the range is clamped into it, and `speed: 0` is static. |
| `label` | no | string | Author note; ignored. |

Hazards are triggers, not solid: an **overlap** (touching edges do not count) puts the player back at the respawn point (`spawn`, or the latest checkpoint) at rest, ends any active ability (ready again), and returns a carried payload to its pad. Hazards, terminals and goals keep their state through a respawn; only a level load (`R`, level switch) resets them. A hazard a terminal has disabled stops moving and is drawn faded. First art is a tinted quad (red; grey when off).

Hazards are indexed by position among the **valid** entries (like platform `visual` flags): an entry the loader skips does not take an index, and the validator says when that shifts a terminal's target.

### `payload`

| Field | Required | Type | Notes |
|---|---|---|---|
| `position` | yes | `{x, y}` | Center of the pad it starts on (and returns to). |
| `size` | yes | `{x, y}` | Width, height. |
| `label` | no | string | Author note; ignored. |

A single object, not an array. Overlap picks it up; it then rides centred on top of the player's collision box and collides with nothing. Dying or reloading puts it back at `position`. **With a payload, the level's goals only fire while it is carried** (once per goal, as usual). Without one, touching a goal completes the level as before, so `test-1`, `demo-decor` and `demo-pano` are unchanged. If either vector is invalid the payload is ignored, and the goals go back to plain touch.

### `terminals[]`

| Field | Required | Type | Notes |
|---|---|---|---|
| `position` | yes | `{x, y}` | Center. |
| `size` | yes | `{x, y}` | Width, height. |
| `disablesHazard` | yes | integer ≥ 0 | Index into the valid `hazards`. A missing or non-integer value skips the terminal; an index past the end makes it do nothing. |
| `label` | no | string | Author note; ignored. |

Pressing the ability key (`E`) while **Volts** overlaps an unused terminal disables that hazard for the rest of the level load and marks the terminal used (drawn green, then dim). That press is the terminal's: it works on the ground or in the air, and while hover is on cooldown, and it does not start a hover or touch the cooldown. Away from a terminal, or at a used one, `E` is the ability as before. Bolts at a terminal gets no terminal effect: `E` stays the ground pound, which only works airborne.

Example (from `public/levels/courier-1.json`):

```json
"hazards": [
  { "position": { "x": 10.0, "y": -2.55 }, "size": { "x": 0.7, "y": 0.5 }, "patrol": { "x0": 8.0, "x1": 12.0, "speed": 1.2 } },
  { "position": { "x": 20.0, "y": -1.0 }, "size": { "x": 0.4, "y": 3.6 } }
],
"payload": { "position": { "x": 3.0, "y": -2.6 }, "size": { "x": 0.4, "y": 0.4 } },
"terminals": [
  { "position": { "x": 17.0, "y": -2.4 }, "size": { "x": 0.6, "y": 0.8 }, "disablesHazard": 1 }
]
```

The validator reports: unknown keys (with typo suggestions), bad vectors, a non-object `patrol` or non-numeric patrol fields, swapped endpoints, negative or zero patrol speed, a patrolling `position.x` outside its range, a terminal target that is missing, not an integer, out of range, or shifted by a skipped hazard, and a payload with no goals to deliver to. For platforms and launchers: a non-boolean `oneWay`, a non-object platform `patrol` or a missing / non-numeric one of its five fields (the platform stays static), negative or zero speed, a path with no length, a `position` off the path, and a launcher with no area or a missing / bad `velocity` (skipped).

Example (from `public/levels/courier-2.json`):

```json
"platforms": [
  { "position": { "x": 3.5, "y": -1.6 }, "size": { "x": 3.0, "y": 0.2 }, "oneWay": true, "label": "hatch" },
  { "position": { "x": 8.0, "y": -1.6 }, "size": { "x": 2.0, "y": 0.2 },
    "patrol": { "x0": 7.5, "y0": -1.6, "x1": 16.5, "y1": -1.6, "speed": 2.0 }, "label": "tram" }
],
"launchers": [
  { "position": { "x": 22.0, "y": -1.3 }, "size": { "x": 1.0, "y": 0.4 }, "velocity": { "x": 0.0, "y": 19.0 } }
]
```

### `camera`

All keys optional; omit the whole object for legacy X-only follow.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `followY` | boolean | `false` | Enable vertical follow. When false the camera Y stays at 0. |
| `verticalDeadzone` | number | `0.75` | Vertical distance the player can move before the camera follows. Clamped to `>= 0`. |
| `lookAheadY` | number | `0.8` | Vertical lead in the direction of travel. |

Wrong-typed keys are dropped individually (e.g. `"followY": "yes"` is ignored).

### `backgroundLayers[]`

Drawn in listed order (**farthest first**), before platforms and decor. Two kinds, chosen by `mode`; parallax layers and world layers can be mixed freely in one array. If the array is missing or yields no valid layers, one default parallax layer is used.

Common key: `image` (required, string) — URL relative to `public/`, e.g. `./background.png`. Entries with empty/missing `image` are skipped. `mode` is `"parallax"` (default, so existing levels need no change) or `"world"`; any other value falls back to `"parallax"`.

#### `mode: "parallax"` (default)

Full-screen quads driven by camera scroll factors — good for atmosphere, not tied to platform coordinates.

| Key | Required | Type | Default | Notes |
|---|---|---|---|---|
| `scrollFactorX` | no | number | `0.4` | `0` = fixed to screen, `1` = moves with the world. |
| `scrollFactorY` | no | number | `0.0` | Needs `camera.followY` to have any visible effect. |
| `scale` | no | number | `1.0` | Clamped to `>= 0.01`. |
| `offsetY` | no | number | `0.0` | World units; shifts the layer vertically. |

**Panorama tip:** parallax layers tile horizontally, so use seamless/wrapping images for wide pans. Stack 2–3 layers with increasing `scrollFactorX` (e.g. 0.05 → 0.2 → 0.4) for depth. If an image fails to load, the level load falls back to the default background.

#### `mode: "world"` — painted panorama placed in world space

A single image occupying a fixed rectangle in world units, so painted ledges, ramps and landmarks can line up with real platform coordinates. It does **not** tile or wrap, and it is drawn through the sprite pipeline, so it respects alpha: paint sky as transparent and a parallax layer listed before it shows through.

| Key | Required | Type | Default | Notes |
|---|---|---|---|---|
| `position` | no | `{x, y}` | centre of `bounds` | **Centre** of the image, world units (same convention as platforms and decor). |
| `size` | no | `{x, y}` | bounds width × image aspect | Full width/height in world units. Both axes must be `> 0`. |
| `parallaxX` / `parallaxY` | no | number | `1.0` | `1` = locked to the world (platforms stay exactly aligned). `< 1` drifts slowly for depth. |

- **Fit to bounds:** omit `size` and/or `position` and the layer is fitted to the level `bounds` (width = bounds width, height from the image aspect ratio, centred on the bounds). With no explicit rectangle *and* no usable `bounds` the layer is skipped, and the validator reports an error.
- **Parallax stays grounded:** the effective camera is `centre + (camera − centre) × factor`, so the painting is exactly aligned with the platforms whenever the camera is at the image's centre and drifts by `(1 − factor) ×` the camera's distance from that centre. Use `1.0` wherever the player must read the art as terrain; use a small drift (e.g. `0.9`) only for backdrop landmarks.
- **Pixel scale:** world units are not pixels. At the default viewport (10 world units wide) a 1280px-wide screen shows ~128 screen px per unit, so aim for ≥ 64 image px per unit; a 58 × 16 unit pano at 64 px/unit is 3712 × 1024.
- **Camera coverage:** the viewport extends half a screen (5 units horizontally; `5 / aspect` vertically) beyond the camera position, and `bounds` clamps the *camera*. To avoid showing empty space, inset `bounds` from the image edges by those amounts, or keep a parallax layer underneath.
- **Alignment workflow:** pick a pixels-per-unit scale, map world → image pixels with `px = (x − (position.x − size.x/2)) × ppu`, `py = ((position.y + size.y/2) − y) × ppu`, and paint each ledge's top surface on a platform's top edge (`position.y + size.y/2`). `scripts/gen_demo_pano.py` does exactly this for the demo level, reading platform coordinates straight from the JSON.
- A world layer whose image fails to load triggers the same fallback as any background layer (default background, console error). The draw is skipped on frames where the image is entirely off screen.

Example (from `public/levels/demo-pano.json`):

```json
"backgroundLayers": [
  { "image": "./background.png", "scrollFactorX": 0.08, "scrollFactorY": 0.02, "scale": 1.5 },
  { "mode": "world", "image": "./levels/demo-pano/pano.png",
    "position": { "x": 22.0, "y": 1.0 }, "size": { "x": 58.0, "y": 16.0 },
    "parallaxX": 1.0, "parallaxY": 1.0 }
]
```

The validator warns when parallax-only keys (`scrollFactor*`, `scale`, `offsetY`) appear on a world layer, or world-only keys (`position`, `size`, `parallaxX/Y`) on a parallax layer, since they have no effect.

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
| `next` | no | Id of the level the *level complete* screen offers next. Trimmed; blank or non-string is dropped. |

If the manifest is missing/invalid, the game falls back to a single built-in `test-1` entry. The first valid entry is the default level; an unknown id also resolves to the first entry.

### The route: `next`

Only the level-complete screen follows `next` (`resolveNextLevel` in `src/game/session.ts`). The dropdown and `1`-`9` still jump to any level. When the entry has no `next`, or it names an id the manifest does not have, the screen shows no Next button and one line saying the route ends; it **never wraps** to the first level. An unknown id is also a `console.warn` when the level is completed. The shipped manifest chains `test-1 → demo-decor → demo-pano → courier-1 → courier-2` (the end); a test keeps it free of dangling ids and loops.

### Progress (`localStorage`)

Kept in the browser only, under the key `bolts-and-volts:progress:v1`: `{ "completed": [levelId, ...], "checkpoints": { levelId: index } }`. No server, no account. A missing, unreadable or blocked store just means no progress.

- **Boot** starts at the first manifest entry not in `completed`, or the first entry when all are. Ids no longer in the manifest are ignored.
- **Completing** a level adds it to `completed` and forgets its checkpoint. A checkpoint is saved as soon as it is entered.
- **Loading a level** (boot, dropdown, `1`-`9`, Next) puts the player back on that level's saved checkpoint via `Game::restoreCheckpoint(index)` after `loadLevel`. Only the position is restored: velocity, character and ability timers start fresh, and hazard / terminal / goal / payload state is the fresh level's. **`R` and the overlay's Reload restart** the level from its spawn and forget its checkpoint.
- **Reset progress** (top-right) removes the key and reloads the first level from its spawn.

### Pause

`Escape` toggles a pause: no input or ticks reach the simulation, the last snapshot keeps drawing under a small overlay. Reaching a goal pauses too, on the complete screen, where `Escape` does nothing; Reload, Next, the dropdown and `1`-`9` end the pause. `C` is ignored while paused.

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

Then register it in `manifest.json` (`{ "id": "minimal", "file": "minimal.json" }`), and add `"next": "minimal"` to the entry that should lead to it.

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

`public/levels/courier-1.json` is the reference for hazards, a payload and a terminal; `public/levels/courier-2.json` for one-way platforms, a moving platform and a launcher.

`public/levels/test-1.json` is the reference for a pure-collision level: it uses only `name`, `description`, `spawn`, `bounds`, `platforms` (with `label`) and `goals`.

## Asset folder convention

Image paths in level JSON are URLs resolved **relative to `public/`** (not relative to the level file), written with a leading `./`. Both `background.png` and `levels/demo-pano/pano.png` therefore work with no code changes.

```text
public/
  background.png, platform.png, wazzy*.png   # shared/global art
  levels/
    manifest.json
    test-1.json
    demo-decor.json
    demo-pano.json
    demo-pano/                # level-specific art, named after the level id
      pano.png
    voltage-valley/           # e.g. future maps
      bg-pano.png
      bg-mountains.png
      props/...
```

Rules of thumb:
- Art used by a single level lives in `public/levels/<level-id>/`; art used by several levels stays at the `public/` root.
- Reference it as `./levels/<level-id>/<file>.png` (e.g. `"image": "./levels/demo-pano/pano.png"`).
- Keep the level JSON itself directly in `public/levels/` (`manifest.json` `file` entries are relative to that folder). Moving a level into its own folder (`<id>/level.json`) is a possible future step and is not supported by the manifest today.
- Existing root-level paths keep working; migrate a level only by moving its files and updating its paths together.
- The reference example is `demo-pano`: its panorama is `./levels/demo-pano/pano.png`.

## Authoring checklist for a new map

1. Put shared art in `public/` (`./file.png`) and level-specific art in `public/levels/<level-id>/` (see [Asset folder convention](#asset-folder-convention)).
2. Set `bounds` a bit wider than your platforms so the camera clamps sensibly.
3. For tall levels, enable `camera.followY` and give background layers a small non-zero `scrollFactorY`.
4. Add the file to `manifest.json`, run `npm run dev`, and pick it from the level dropdown (`R` reloads the level).
5. Check the browser console for `[level …]` errors/warnings after each load (field-path messages from the validator, plus `Failed to load decor texture` for images that don't exist).
