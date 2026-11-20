/** Backing-store pixels per CSS pixel are capped here: past 2x the extra fill cost buys nothing for pixel art. */
export const MAX_PIXEL_RATIO = 2;

export type CanvasSize = {
  /** Drawing-buffer width in device pixels. */
  width: number;
  /** Drawing-buffer height in device pixels. */
  height: number;
  /** Backing-store pixels per CSS pixel (`min(devicePixelRatio, MAX_PIXEL_RATIO)`). */
  pixelRatio: number;
};

/**
 * Backing-store size for a canvas whose content box is `cssWidth` x `cssHeight` CSS pixels.
 * Returns null for a degenerate (hidden / zero-sized) box so callers keep the previous size.
 */
export function backingStoreSize(cssWidth: number, cssHeight: number, devicePixelRatio: number): CanvasSize | null {
  if (!(cssWidth > 0) || !(cssHeight > 0)) return null;
  const pixelRatio = Math.min(devicePixelRatio > 0 ? devicePixelRatio : 1, MAX_PIXEL_RATIO);
  return {
    width: Math.max(1, Math.round(cssWidth * pixelRatio)),
    height: Math.max(1, Math.round(cssHeight * pixelRatio)),
    pixelRatio,
  };
}

/**
 * Report the canvas's backing-store size now and whenever it should change: the content box
 * resizes (`ResizeObserver`) or `devicePixelRatio` changes without a layout change (browser zoom
 * of a max-width container, dragging the window to another monitor). Returns a disposer.
 */
export function observeCanvasSize(canvas: HTMLCanvasElement, onSize: (size: CanvasSize) => void): () => void {
  let cssWidth = canvas.clientWidth;
  let cssHeight = canvas.clientHeight;
  const report = () => {
    const size = backingStoreSize(cssWidth, cssHeight, window.devicePixelRatio);
    if (size) onSize(size);
  };

  const resizeObserver = new ResizeObserver((entries) => {
    const rect = entries[entries.length - 1].contentRect;
    cssWidth = rect.width;
    cssHeight = rect.height;
    report();
  });
  resizeObserver.observe(canvas);

  // A `(resolution: Ndppx)` query only matches the current ratio, so it fires once on any change; re-arm it each time.
  let ratioQuery: MediaQueryList | null = null;
  const onRatioChange = () => {
    report();
    watchRatio();
  };
  const watchRatio = () => {
    ratioQuery?.removeEventListener('change', onRatioChange);
    ratioQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    ratioQuery.addEventListener('change', onRatioChange);
  };
  watchRatio();

  report();
  return () => {
    resizeObserver.disconnect();
    ratioQuery?.removeEventListener('change', onRatioChange);
  };
}
