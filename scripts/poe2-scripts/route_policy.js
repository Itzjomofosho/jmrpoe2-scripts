/**
 * route_policy.js — stable destination identity + route-corridor geometry.
 *
 * Pure and game-API free on purpose: navigation policy is testable with plain node
 * (route_policy.test.mjs) without loading the mapper runtime.
 */

// Quantized, LABEL-INDEPENDENT destination identity. Two walks to the same place are the same
// destination even when the caller renames the target ('Boss Explore' -> 'Empty Pass-Through').
export function destinationKey(kind, x, y, cellSize = 24) {
  const safeKind = String(kind || 'walk').trim().toLowerCase() || 'walk';
  const cell = Math.max(1, Number(cellSize) || 24);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return `${safeKind}:unknown`;
  return `${safeKind}:${Math.round(x / cell)}:${Math.round(y / cell)}`;
}

function pointSegmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 <= 0.0001) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

// Distance from a point to the UNCONSUMED part of a path. The player position seeds the first
// segment origin so already-walked breadcrumbs behind us can never read as "on route".
// maxSegments bounds the cost: this runs inside per-frame chase gates.
export function distanceToRemainingPath(pointX, pointY, path, startIndex, originX, originY, maxSegments = 96) {
  if (!Array.isArray(path) || path.length === 0) return Infinity;
  const from = Math.max(0, Math.min(path.length - 1, Number(startIndex) || 0));
  let ax = originX;
  let ay = originY;
  let best = Infinity;
  let used = 0;

  for (let i = from; i < path.length && used < maxSegments; i++, used++) {
    const p = path[i];
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    if (!Number.isFinite(ax) || !Number.isFinite(ay)) { ax = p.x; ay = p.y; continue; }
    best = Math.min(best, pointSegmentDistance(pointX, pointY, ax, ay, p.x, p.y));
    ax = p.x;
    ay = p.y;
  }
  return best;
}

// Is an opportunistic target near enough to the remaining committed corridor to be worth diverting to?
// With no path yet, falls back to projecting onto the player->destination segment.
export function isPointOnCommittedRoute({
  pointX,
  pointY,
  playerX,
  playerY,
  targetX,
  targetY,
  path,
  startIndex = 0,
  maxDetour = 120,
  maxPointDistance = 220,
}) {
  if (![pointX, pointY, playerX, playerY].every(Number.isFinite)) return false;
  if (Math.hypot(pointX - playerX, pointY - playerY) > maxPointDistance) return false;

  const pathDistance = distanceToRemainingPath(pointX, pointY, path, startIndex, playerX, playerY);
  if (Number.isFinite(pathDistance)) return pathDistance <= maxDetour;

  if (!Number.isFinite(targetX) || !Number.isFinite(targetY)) return false;
  const routeX = targetX - playerX;
  const routeY = targetY - playerY;
  const routeLen2 = routeX * routeX + routeY * routeY;
  if (routeLen2 < 1) return true;
  const t = ((pointX - playerX) * routeX + (pointY - playerY) * routeY) / routeLen2;
  const perpendicular = Math.hypot(pointX - (playerX + routeX * t), pointY - (playerY + routeY * t));
  return t >= -0.1 && t <= 1.2 && perpendicular <= maxDetour;
}

// A native terrain route that ends BESIDE its own start while the destination is still far away is an
// authoritative "corridor blocked" answer, not a failed search. Treating it as no-answer lets a coarse
// fallback draw a straight line through the obstacle -- which is what the walker then rams.
export function nativePathBlocksCoarseFallback({
  path,
  fromX,
  fromY,
  targetX,
  targetY,
  arrivalThreshold = 30,
  endpointRadius = 24,
}) {
  if (!Array.isArray(path) || path.length === 0) return false;
  let end = null;
  for (let i = path.length - 1; i >= 0; i--) {
    const point = path[i];
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) { end = point; break; }
  }
  if (!end || ![fromX, fromY, targetX, targetY].every(Number.isFinite)) return false;
  const targetDistance = Math.hypot(end.x - targetX, end.y - targetY);
  const startDistance = Math.hypot(end.x - fromX, end.y - fromY);
  return targetDistance > Math.max(40, Number(arrivalThreshold) || 0)
    && startDistance <= Math.max(8, Number(endpointRadius) || 24);
}
