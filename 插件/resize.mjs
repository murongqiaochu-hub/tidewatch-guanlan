// Resize only by dragging the panel's lower edge; keyboard users have the same bounded action.
import { number } from './core.mjs';
export const UI_WIDTH = 480;
export const MIN_HEIGHT = 480;
export const MAX_HEIGHT = 1100;
export function clampedHeight(value) { number(value, -1e6, 1e6); return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(value))); }
export function resizeKey(current, key) {
  if (key === 'ArrowUp' || key === 'PageUp') return clampedHeight(current + (key === 'PageUp' ? 160 : 40));
  if (key === 'ArrowDown' || key === 'PageDown') return clampedHeight(current - (key === 'PageDown' ? 160 : 40));
  if (key === 'Home') return MIN_HEIGHT;
  if (key === 'End') return MAX_HEIGHT;
  return null;
}
export function dragHeightIntent(down, move) {
  if (!down || move?.isTrusted !== true || move.pointerId !== down.pointerId || move.isPrimary === false || !Number.isFinite(move.screenY)) return null;
  return clampedHeight(down.height + move.screenY - down.screenY);
}
export function bindResizeControls(root, { getHeight, resize } = {}) {
  const edge = root.getElementById('plugin-resize-edge'); if (!edge) return () => {};
  const view = root.defaultView || root.ownerDocument?.defaultView || null;
  let down = null, disposed = false, inFlight = false, wanted = null, last = null;
  const drain = async () => {
    if (inFlight || disposed) return;
    inFlight = true;
    try { while (!disposed && wanted !== null) { const next = wanted; wanted = null; if (last === next) continue; try { await resize(next); last = next; } catch { /* The host reports its own resize failure. */ } } }
    finally { inFlight = false; }
  };
  const queue = next => { if (next === null || disposed) return; wanted = next; void drain(); };
  const release = pointerId => { try { if (pointerId != null && edge.hasPointerCapture?.(pointerId)) edge.releasePointerCapture(pointerId); } catch { /* Capture may already be gone. */ } };
  const stop = (event, { commit = false } = {}) => {
    if (!down) return;
    if (event?.pointerId != null && event.pointerId !== down.pointerId) return;
    if (commit) queue(dragHeightIntent(down, event));
    const pointerId = down.pointerId;
    down = null; edge.dataset.dragging = 'false'; release(pointerId);
  };
  const pointerdown = event => {
    if (event.isTrusted !== true || event.button !== 0 || event.isPrimary === false || !Number.isFinite(event.screenY)) return;
    down = { pointerId: event.pointerId, screenY: event.screenY, height: getHeight() };
    edge.dataset.dragging = 'true';
    try { edge.setPointerCapture?.(event.pointerId); } catch { /* Window-level listeners remain the fallback. */ }
    event.preventDefault();
  };
  // A fast drag can leave the iframe before pointerup arrives. A later move with no
  // pressed button is a release, never a new resize of the stale drag origin.
  const pointermove = event => {
    if (!down || event.pointerId !== down.pointerId) return;
    if ((event.buttons & 1) !== 1) { stop(event); return; }
    queue(dragHeightIntent(down, event));
  };
  const pointerup = event => { if (!down || event.pointerId !== down.pointerId) return; stop(event, { commit: true }); event.preventDefault(); };
  const pointercancel = event => stop(event);
  const lostCapture = event => stop(event);
  const blur = () => stop(null);
  const visibility = () => { if (view?.document?.visibilityState === 'hidden') stop(null); };
  const keydown = event => { if (event.isTrusted !== true) return; const next = resizeKey(getHeight(), event.key); if (next !== null) { event.preventDefault(); queue(next); } };
  edge.addEventListener('pointerdown',pointerdown);edge.addEventListener('pointermove',pointermove);edge.addEventListener('pointerup',pointerup);edge.addEventListener('pointercancel',pointercancel);edge.addEventListener('lostpointercapture',lostCapture);edge.addEventListener('keydown',keydown);
  view?.addEventListener('pointerup',pointerup,true); view?.addEventListener('pointercancel',pointercancel,true); view?.addEventListener('blur',blur); view?.document?.addEventListener('visibilitychange',visibility);
  return () => { disposed=true; wanted=null; down=null;edge.removeEventListener('pointerdown',pointerdown);edge.removeEventListener('pointermove',pointermove);edge.removeEventListener('pointerup',pointerup);edge.removeEventListener('pointercancel',pointercancel);edge.removeEventListener('lostpointercapture',lostCapture);edge.removeEventListener('keydown',keydown);view?.removeEventListener('pointerup',pointerup,true);view?.removeEventListener('pointercancel',pointercancel,true);view?.removeEventListener('blur',blur);view?.document?.removeEventListener('visibilitychange',visibility); };
}
