import assert from 'node:assert/strict';
import {
  destinationKey,
  distanceToRemainingPath,
  isPointOnCommittedRoute,
  nativePathBlocksCoarseFallback,
} from './route_policy.js';

// identity: label case/spacing normalized, coords quantized to the 24u cell
assert.equal(destinationKey('Boss Route', 48, 72), 'boss route:2:3');
assert.equal(destinationKey('boss-route', 49, 71), 'boss-route:2:3');
assert.equal(destinationKey('nav-route', NaN, 10), 'nav-route:unknown');
// a frontier hop inside the same cell keeps its key; a real destination change does not
assert.equal(destinationKey('boss-route', 1000, 500), destinationKey('boss-route', 1010, 508));
assert.notEqual(destinationKey('boss-route', 1000, 500), destinationKey('boss-route', 1200, 500));

const path = [{ x: 50, y: 0 }, { x: 100, y: 0 }, { x: 150, y: 0 }];
assert.equal(distanceToRemainingPath(75, 20, path, 0, 0, 0), 20);
// consumed breadcrumbs behind the player must not count as "on route"
assert.ok(distanceToRemainingPath(25, 0, path, 2, 100, 0) >= 75);
assert.equal(distanceToRemainingPath(0, 0, null, 0, 0, 0), Infinity);

assert.equal(isPointOnCommittedRoute({
  pointX: 90, pointY: 25, playerX: 0, playerY: 0, targetX: 150, targetY: 0, path, maxDetour: 30,
}), true);
assert.equal(isPointOnCommittedRoute({
  pointX: 90, pointY: 60, playerX: 0, playerY: 0, targetX: 150, targetY: 0, path, maxDetour: 30,
}), false);
// behind the player, no path available -> segment projection rejects it
assert.equal(isPointOnCommittedRoute({
  pointX: -80, pointY: 0, playerX: 0, playerY: 0, targetX: 150, targetY: 0, path: null, maxDetour: 30,
}), false);
// beyond maxPointDistance is refused before any geometry runs
assert.equal(isPointOnCommittedRoute({
  pointX: 400, pointY: 0, playerX: 0, playerY: 0, targetX: 500, targetY: 0, path, maxPointDistance: 220,
}), false);

// degenerate native answer: ends beside the start, destination still far -> blocked corridor
assert.equal(nativePathBlocksCoarseFallback({
  path: [{ x: 1492, y: 788 }], fromX: 1490, fromY: 790, targetX: 1470, targetY: 896,
}), true);
// walked a real distance from the start -> a legitimate partial route, not a veto
assert.equal(nativePathBlocksCoarseFallback({
  path: [{ x: 1514, y: 762 }, { x: 1492, y: 788 }], fromX: 1514, fromY: 762, targetX: 1470, targetY: 896,
}), false);
// reaches the destination -> never a veto
assert.equal(nativePathBlocksCoarseFallback({
  path: [{ x: 1490, y: 790 }, { x: 1470, y: 896 }], fromX: 1490, fromY: 790, targetX: 1470, targetY: 896,
}), false);
// no answer at all is not a blocked verdict (the route stack must keep trying)
assert.equal(nativePathBlocksCoarseFallback({
  path: [], fromX: 0, fromY: 0, targetX: 500, targetY: 0,
}), false);

console.log('route_policy tests passed');
