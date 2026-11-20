import React, { useRef, useEffect, useState } from 'react';
import { Renderer, type BackgroundLayer, type DecorLayers } from '../gl/renderer';
import { loadWasmModule, type Game } from '../wasm/loader';
import { AudioManager } from '../audio/AudioManager';
import { DEFAULT_LEVELS, normalizeLevelManifest, resolveLevelEntry, type LevelManifestEntry } from '../lib/levelManifest';
import {
  GRID_STEPS,
  INITIAL_AUTHORING_STATE,
  cycleGridStep,
  platformSnippet,
  screenToWorld,
  snapToGrid,
  viewSize,
  type AuthoringOverlay,
  type AuthoringState,
} from '../lib/authoring';
import { formatCullStats } from '../lib/culling';
import { observeCanvasSize, type CanvasSize } from '../lib/canvasSize';
import { reportLevelIssues, summarizeLevelIssues, validateLevel, type LevelIssueSummary } from '../lib/levelValidator';
import { DEFAULT_BACKGROUND_LAYER, isRecord, normalizeLevelData } from '../lib/levelData';
import { EMPTY_DECOR_LAYERS, createLevelAssetLoader } from '../game/levelAssets';
import { KeyboardInput } from '../game/input';
import { startGameLoop, type SceneAssets } from '../game/loop';
import type { FrameState } from '../game/snapshot';
import { createAbilityHudWriter } from '../game/abilityHud';
import AbilityHud from './AbilityHud';

import vertexShaderSource from '../gl/shaders/tex.vert.glsl?raw';
import fragmentShaderSource from '../gl/shaders/tex.frag.glsl?raw';
import backgroundFragmentSource from '../gl/shaders/background.frag.glsl?raw';
import backgroundVertexSource from '../gl/shaders/background.vert.glsl?raw';

const WAZZY_SPRITESHEET_URL = './wazzy_spritesheet.png';
const PLATFORM_TEXTURE_URL = './platform.png';
const MUSIC_URL = './background-music.mp3';
// Keys are the sound names the simulation emits (`Game::dispatchEvents` in cpp/src/Game.cpp); `playSfx` ignores unknown names.
const SFX_URLS: Record<string, string> = {
  jump: './jump.mp3',
  land: './land.mp3',
  ground_pound: './ground_pound.mp3',
  hover: './hover.mp3',
  switch: './switch.mp3',
};
const INITIAL_VOLUME = 0.5;

type LevelMetadata = {
  id: string;
  name: string;
  description: string;
  author: string;
};

/** Write `text` into `el` only when it changed: the game loop calls this every frame. */
const setText = (el: HTMLElement | null, text: string) => {
  if (el && el.textContent !== text) el.textContent = text;
};

/**
 * React shell around the game: mounts the canvas, level select, volume, overlays. Per-frame work lives in
 * `startGameLoop` (src/game/loop.ts); per-frame HUD text is written straight to DOM refs, so this component
 * only re-renders on level change, volume, hotkey toggles and level complete.
 */
const GameCanvas = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const abilityHudRef = useRef<HTMLDivElement>(null);
  const authoringInfoRef = useRef<HTMLDivElement>(null);
  const cullInfoRef = useRef<HTMLDivElement>(null);
  const audioManagerRef = useRef<AudioManager | null>(null);
  const gameInstanceRef = useRef<Game | null>(null);
  const reloadLevelRef = useRef<((targetLevelId?: string, cacheBust?: boolean) => Promise<void>) | null>(null);
  const levelsRef = useRef<LevelManifestEntry[]>(DEFAULT_LEVELS);
  const currentLevelIdRef = useRef<string>(DEFAULT_LEVELS[0].id);
  // Level-authoring aids (G grid, Shift+G grid step, H authoring mode, P copy platform JSON).
  // The ref is what the key handler and game loop read; the state mirrors it for the React HUD.
  const authoringRef = useRef<AuthoringState>(INITIAL_AUTHORING_STATE);
  const mouseRef = useRef<{ u: number; v: number } | null>(null);
  const snappedCursorRef = useRef<{ x: number; y: number } | null>(null);
  const copyNoteTimerRef = useRef<number | undefined>(undefined);
  const [authoring, setAuthoring] = useState<AuthoringState>(INITIAL_AUTHORING_STATE);
  // K: cull debug (outlines the shrunken visible rect and shows drawn/total counters). Render-only.
  const cullDebugRef = useRef(false);
  const [cullDebug, setCullDebug] = useState(false);
  const [copyNote, setCopyNote] = useState('');
  const [volume, setVolume] = useState(INITIAL_VOLUME);
  const [levelComplete, setLevelComplete] = useState(false);
  const [availableLevels, setAvailableLevels] = useState<LevelManifestEntry[]>(DEFAULT_LEVELS);
  const [currentLevelId, setCurrentLevelId] = useState<string>(DEFAULT_LEVELS[0].id);
  const [levelIssues, setLevelIssues] = useState<LevelIssueSummary | null>(null);
  const [currentLevelMetadata, setCurrentLevelMetadata] = useState<LevelMetadata>({
    id: DEFAULT_LEVELS[0].id,
    name: DEFAULT_LEVELS[0].name ?? DEFAULT_LEVELS[0].id,
    description: '',
    author: '',
  });

  // Audio + one-shot hotkeys. Held movement keys are read by KeyboardInput in the game loop.
  useEffect(() => {
    audioManagerRef.current = new AudioManager();
    const audioManager = audioManagerRef.current;
    audioManager.setVolume(INITIAL_VOLUME);

    const handleKeyDown = (e: KeyboardEvent) => {
      audioManager.resumeContext();
      audioManager.playMusic();

      // R key: reload current level JSON (great for iterating on map design)
      if (e.code === 'KeyR') {
        void reloadLevelRef.current?.(currentLevelIdRef.current, true);
      }

      // C key: switch between Bolts and Volts (the HUD picks the new character up from the next snapshot)
      if (e.code === 'KeyC') {
        gameInstanceRef.current?.switchCharacter();
      }

      // Authoring hotkeys: only plain presses (no Ctrl/Meta/Alt, no key-repeat) and never while a form
      // control has focus, so they can't fight the level dropdown, browser shortcuts or existing keys.
      const target = e.target as HTMLElement | null;
      const inFormControl = target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement;
      if (!inFormControl && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat) {
        const current = authoringRef.current;
        let next: AuthoringState | null = null;
        if (e.code === 'KeyG') {
          // G toggles the grid; Shift+G cycles its spacing (and turns it on so the change is visible).
          next = e.shiftKey
            ? { ...current, grid: true, gridStepIndex: cycleGridStep(current.gridStepIndex) }
            : { ...current, grid: !current.grid };
        } else if (e.code === 'KeyH') {
          next = { ...current, hud: !current.hud };
        } else if (e.code === 'KeyP' && current.hud) {
          const cursor = snappedCursorRef.current;
          if (cursor) {
            const snippet = platformSnippet(cursor);
            const note = (text: string) => {
              setCopyNote(text);
              window.clearTimeout(copyNoteTimerRef.current);
              copyNoteTimerRef.current = window.setTimeout(() => setCopyNote(''), 2000);
            };
            if (navigator.clipboard?.writeText) {
              navigator.clipboard.writeText(snippet).then(() => note('Copied platform JSON'), () => note('Clipboard blocked — see console'));
            } else {
              note('Clipboard unavailable — see console');
            }
            console.info('[authoring] platform snippet:', snippet);
          }
        }
        if (e.code === 'KeyK') {
          cullDebugRef.current = !cullDebugRef.current;
          setCullDebug(cullDebugRef.current);
        }
        if (next) {
          authoringRef.current = next;
          setAuthoring(next);
        }
      }

      if (e.code.startsWith('Digit')) {
        const index = Number.parseInt(e.code.replace('Digit', ''), 10) - 1;
        if (index >= 0 && index < levelsRef.current.length) {
          const target = levelsRef.current[index];
          void reloadLevelRef.current?.(target.id, false);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      audioManager.stopMusic();
      window.clearTimeout(copyNoteTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let stopLoop: (() => void) | null = null;
    let gameInstance: Game | null = null;
    // Set by cleanup. React StrictMode runs this effect twice in dev, and the first run's async init would
    // otherwise carry on as a second game + renderer on the same canvas (never resized, drawn over the live one).
    let disposed = false;
    const audioManager = audioManagerRef.current!;
    const input = new KeyboardInput();

    // The observer only records the latest size; the game loop applies it right before drawing. Resizing a
    // canvas clears it, so doing that from the observer callback (after rAF) would present a blank frame.
    let pendingSize: CanvasSize | null = null;
    const stopObservingSize = observeCanvasSize(canvas, (size) => { pendingSize = size; });

    const initializeAndRun = async () => {
      try {
        await Promise.all([
          ...Object.entries(SFX_URLS).map(([name, url]) => audioManager.loadSfx(name, url)),
          audioManager.loadMusic(MUSIC_URL)
        ]);

        const wasmModule = await loadWasmModule();
        if (disposed) return;
        const game = new wasmModule.Game();
        gameInstance = game;
        game.setSoundCallback((soundName: string) => audioManager.playSfx(soundName));
        game.setLevelCompleteCallback(() => setLevelComplete(true));

        const renderer = new Renderer(canvas, vertexShaderSource, fragmentShaderSource, backgroundVertexSource, backgroundFragmentSource);
        const applyPendingSize = () => {
          if (!pendingSize) return;
          renderer.resize(pendingSize);
          pendingSize = null;
        };
        applyPendingSize();
        const [playerTexture, platformTexture] = await Promise.all([
          renderer.loadTexture(WAZZY_SPRITESHEET_URL),
          renderer.loadTexture(PLATFORM_TEXTURE_URL),
        ]);
        const assets: SceneAssets = {
          playerTexture,
          platformTexture,
          backgroundLayers: [],
          decorLayers: EMPTY_DECOR_LAYERS,
          platformVisualFlags: [],
        };
        const { loadBackgroundLayers, loadDecorLayers } = createLevelAssetLoader(renderer, () => `[level ${currentLevelIdRef.current}]`);
        const setLevelAssets = (backgroundLayers: BackgroundLayer[], decorLayers: DecorLayers, platformVisualFlags: boolean[]) => {
          assets.backgroundLayers = backgroundLayers;
          assets.decorLayers = decorLayers;
          assets.platformVisualFlags = platformVisualFlags;
        };

        const loadManifest = async (): Promise<void> => {
          try {
            const response = await fetch('/levels/manifest.json');
            if (!response.ok) {
              levelsRef.current = DEFAULT_LEVELS;
              setAvailableLevels(DEFAULT_LEVELS);
              return;
            }
            const manifestObj: unknown = await response.json();
            const normalized = normalizeLevelManifest(manifestObj);
            levelsRef.current = normalized;
            setAvailableLevels(normalized);
          } catch (error) {
            console.warn('Error loading level manifest, using default:', error);
            levelsRef.current = DEFAULT_LEVELS;
            setAvailableLevels(DEFAULT_LEVELS);
          }
        };
        const loadLevelData = async (targetLevelId?: string, cacheBust: boolean = false) => {
          const targetLevel = resolveLevelEntry(levelsRef.current, targetLevelId);
          currentLevelIdRef.current = targetLevel.id;
          setCurrentLevelId(targetLevel.id);
          const levelUrl = cacheBust
            ? `/levels/${targetLevel.file}?ts=${Date.now()}`
            : `/levels/${targetLevel.file}`;
          const levelLabel = `${targetLevel.id} (${targetLevel.file})`;
          const manifestMetadata: LevelMetadata = {
            id: targetLevel.id,
            name: targetLevel.name ?? targetLevel.id,
            description: targetLevel.description ?? '',
            author: targetLevel.author ?? '',
          };
          const reportLoadFailure = (message: string, detail?: unknown): void => {
            const full = `[level ${levelLabel}] ${message}`;
            if (detail === undefined) console.error(full); else console.error(full, detail);
            setLevelIssues({ errors: 1, warnings: 0, first: full });
          };
          try {
            const levelResp = await fetch(levelUrl);
            if (levelResp.ok) {
              const levelObj: unknown = await levelResp.json();
              // Validation only reports; the lenient normalizer still decides what loads.
              const issues = validateLevel(levelObj);
              reportLevelIssues(levelLabel, issues);
              setLevelIssues(issues.length > 0 ? summarizeLevelIssues(levelLabel, issues) : null);
              const normalized = normalizeLevelData(levelObj);
              game.loadLevel(normalized.coreLevel);
              setLevelAssets(
                await loadBackgroundLayers(normalized.backgroundLayers),
                await loadDecorLayers(normalized.decor),
                normalized.platformVisualFlags,
              );
              setCurrentLevelMetadata({
                id: targetLevel.id,
                name: game.getLevelName().trim() || targetLevel.name || targetLevel.id,
                description: game.getLevelDescription().trim() || targetLevel.description || '',
                author: isRecord(levelObj) && typeof levelObj.author === 'string' ? levelObj.author : (targetLevel.author ?? ''),
              });
            } else {
              reportLoadFailure(`Failed to fetch ${levelUrl}: HTTP ${levelResp.status}. Loading default background and no level data.`);
              setLevelAssets(await loadBackgroundLayers([DEFAULT_BACKGROUND_LAYER]), EMPTY_DECOR_LAYERS, []);
              setCurrentLevelMetadata(manifestMetadata);
            }
          } catch (err) {
            reportLoadFailure('Error loading level (invalid JSON syntax, or a background texture failed to load). Falling back to the default background.', err);
            setLevelAssets(await loadBackgroundLayers([DEFAULT_BACKGROUND_LAYER]), EMPTY_DECOR_LAYERS, []);
            setCurrentLevelMetadata(manifestMetadata);
          }
        };
        await loadManifest();
        await loadLevelData(undefined, false);
        if (disposed) return;

        // Reload function for rapid iteration (R key, level select, digits, overlay buttons)
        reloadLevelRef.current = async (targetLevelId?: string, cacheBust: boolean = false) => {
          try {
            await loadLevelData(targetLevelId, cacheBust);
            setLevelComplete(false);
          } catch (e) {
            console.warn('Failed to reload level:', e);
          }
        };
        gameInstanceRef.current = game;

        // Level-authoring overlay: cursor -> world coordinates and the options handed to the renderer.
        const authoringOverlay = (frame: FrameState): AuthoringOverlay | null => {
          const state = authoringRef.current;
          if (!state.grid && !state.hud) {
            snappedCursorRef.current = null;
            return null;
          }
          const camera = frame.camera;
          const gridStep = GRID_STEPS[state.gridStepIndex];
          const view = viewSize(canvas.width, canvas.height);
          const mouse = mouseRef.current;
          const world = mouse ? screenToWorld(mouse.u, mouse.v, camera, view) : null;
          const snapped = world ? snapToGrid(world, gridStep) : null;
          snappedCursorRef.current = snapped;
          if (state.hud) {
            const f = (n: number) => n.toFixed(2);
            setText(authoringInfoRef.current, [
              `AUTHORING  grid ${state.grid ? gridStep : 'off'}`,
              world ? `mouse  ${f(world.x)}, ${f(world.y)}` : 'mouse  (off canvas)',
              snapped ? `snap   ${f(snapped.x)}, ${f(snapped.y)}` : 'snap   -',
              `camera ${f(camera.x)}, ${f(camera.y)}`,
              `view   x ${f(camera.x - view.x / 2)}..${f(camera.x + view.x / 2)}  y ${f(camera.y - view.y / 2)}..${f(camera.y + view.y / 2)}`,
            ].join('\n'));
          }
          return { grid: state.grid, gridStep, strongOutlines: state.hud, snapMarker: state.hud ? snapped : null };
        };

        // Ability overlay: markup is rendered once below, the loop fills it in (no React state per frame).
        const writeAbilityHud = createAbilityHudWriter(abilityHudRef.current!);

        stopLoop = startGameLoop({
          module: wasmModule,
          game,
          renderer,
          input,
          assets,
          beforeFrame: applyPendingSize,
          overlay: authoringOverlay,
          cullDebug: () => cullDebugRef.current,
          afterDraw: (frame) => {
            writeAbilityHud(frame);
            if (cullDebugRef.current) setText(cullInfoRef.current, formatCullStats(renderer.getCullStats()));
          },
        });
      } catch (error) {
        console.error("Failed to initialize game:", error);
      }
    };

    initializeAndRun();

    return () => {
      disposed = true;
      stopObservingSize();
      stopLoop?.();
      input.dispose();
      reloadLevelRef.current = null;
      gameInstanceRef.current = null;
      if (gameInstance) gameInstance.delete();
    };
  }, []);

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVolume = parseFloat(e.target.value);
    setVolume(newVolume);
    audioManagerRef.current?.setVolume(newVolume);
  };

  const canvasStyle: React.CSSProperties = {
    width: '100%', height: '100%', backgroundColor: '#000',
    // The backing store follows this box (see observeCanvasSize), so it must not also size the box. In flow, the
    // canvas's intrinsic size (= backing store) raises the flex item's minimum height, the box grows, the backing
    // store follows, and so on. Out of flow it contributes nothing to its parent's size.
    position: 'absolute', top: 0, left: 0,
    borderRadius: '8px', boxShadow: '0 0 20px rgba(0, 170, 255, 0.5)',
    border: '2px solid var(--primary-color)'
  };

  // Track the cursor as a fraction of the canvas content box so it stays correct however the canvas is stretched.
  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const u = (e.clientX - rect.left - canvas.clientLeft) / canvas.clientWidth;
    const v = (e.clientY - rect.top - canvas.clientTop) / canvas.clientHeight;
    mouseRef.current = u >= 0 && u <= 1 && v >= 0 && v <= 1 ? { u, v } : null;
  };

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <canvas
        ref={canvasRef}
        style={canvasStyle}
        onMouseMove={handleCanvasMouseMove}
        onMouseLeave={() => { mouseRef.current = null; }}
      />
      <div style={{ position: 'absolute', top: '10px', right: '10px', zIndex: 10, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
        <select
          value={currentLevelId}
          onChange={(e) => { void reloadLevelRef.current?.(e.target.value, false); }}
          style={{
            background: 'rgba(0,0,0,0.75)',
            color: '#0ff',
            border: '1px solid #0ff',
            borderRadius: '4px',
            padding: '3px 6px',
            fontSize: '12px',
            fontFamily: 'monospace',
          }}
        >
          {availableLevels.map((level, index) => (
            <option key={level.id} value={level.id}>
              {index + 1}. {level.name ?? level.id}
            </option>
          ))}
        </select>
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={volume}
          onChange={handleVolumeChange}
        />
        <div style={{ fontSize: '11px', opacity: 0.7, fontFamily: 'monospace', color: '#0ff' }}>
          1-9: switch map • R: reload map • C: switch dog • E: ability<br />G: grid (Shift+G: spacing) • H: authoring mode (P: copy platform) • K: cull debug
        </div>
      </div>
      <div style={{ position: 'absolute', left: '10px', top: '10px', zIndex: 30, color: '#0ff', background: 'rgba(0,0,0,0.6)', padding: '6px', fontFamily: 'monospace', fontSize: '12px', borderRadius: '4px', maxWidth: '45%' }}>
        <div style={{ fontWeight: 700 }}>{currentLevelMetadata.name}</div>
        {currentLevelMetadata.description && (
          <div style={{ opacity: 0.85, marginTop: 2 }}>{currentLevelMetadata.description}</div>
        )}
        {currentLevelMetadata.author && (
          <div style={{ opacity: 0.75, marginTop: 2 }}>by {currentLevelMetadata.author}</div>
        )}
        {/* Character, ability and cooldown bar: written by the game loop, not React. */}
        <AbilityHud rootRef={abilityHudRef} />
      </div>
      {cullDebug && (
        <div
          ref={cullInfoRef}
          data-testid="cull-hud"
          style={{
            position: 'absolute', right: '10px', bottom: '44px', zIndex: 30, color: '#f80', background: 'rgba(0,0,0,0.75)',
            padding: '6px 8px', fontFamily: 'monospace', fontSize: '12px', borderRadius: '4px', whiteSpace: 'pre', pointerEvents: 'none',
          }}
        />
      )}
      {authoring.hud && (
        <div
          data-testid="authoring-hud"
          style={{
            position: 'absolute', left: '10px', bottom: '44px', zIndex: 30, color: '#ff0', background: 'rgba(0,0,0,0.75)',
            padding: '6px 8px', fontFamily: 'monospace', fontSize: '12px', borderRadius: '4px', whiteSpace: 'pre', pointerEvents: 'none',
          }}
        >
          <div ref={authoringInfoRef} />
          {copyNote && <div style={{ color: '#f0f', marginTop: 4 }}>{copyNote}</div>}
        </div>
      )}
      {import.meta.env.DEV && levelIssues && (
        <div
          role="status"
          style={{
            position: 'absolute', left: '50%', top: '10px', transform: 'translateX(-50%)', zIndex: 31,
            maxWidth: '40%', color: '#fff', background: levelIssues.errors > 0 ? 'rgba(160,20,20,0.9)' : 'rgba(150,100,0,0.9)',
            padding: '6px 10px', fontFamily: 'monospace', fontSize: '11px', borderRadius: '4px', pointerEvents: 'none',
          }}
        >
          <div style={{ fontWeight: 700 }}>
            Level loaded with {levelIssues.errors} error{levelIssues.errors === 1 ? '' : 's'}, {levelIssues.warnings} warning{levelIssues.warnings === 1 ? '' : 's'} — see console
          </div>
          {levelIssues.first && <div style={{ opacity: 0.9, marginTop: 2, wordBreak: 'break-word' }}>{levelIssues.first}</div>}
        </div>
      )}
      <div style={{ position: 'absolute', left: '10px', bottom: '10px', zIndex: 30, color: '#0ff', background: 'rgba(0,0,0,0.6)', padding: '6px', fontFamily: 'monospace', fontSize: '11px', borderRadius: '4px' }}>
        level: {currentLevelMetadata.id} ({currentLevelId})
      </div>
      {levelComplete && (
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.8)', color: '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '2rem', zIndex: 20
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
            <div>Level Complete!</div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                type="button"
                onClick={() => { void reloadLevelRef.current?.(currentLevelId, true); }}
                style={{ padding: '8px 14px', borderRadius: 6, border: '1px solid #0ff', background: '#022', color: '#0ff', cursor: 'pointer' }}
              >
                Reload
              </button>
              <button
                type="button"
                onClick={() => {
                  const currentIndex = availableLevels.findIndex((level) => level.id === currentLevelId);
                  const nextLevel = currentIndex >= 0 ? availableLevels[(currentIndex + 1) % availableLevels.length] : undefined;
                  if (nextLevel) {
                    void reloadLevelRef.current?.(nextLevel.id, false);
                  }
                }}
                style={{ padding: '8px 14px', borderRadius: 6, border: '1px solid #0ff', background: '#044', color: '#0ff', cursor: 'pointer' }}
              >
                Next
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default GameCanvas;
