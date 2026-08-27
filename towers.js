const { TOWER_HEIGHT, GROUND_AREA, PLAYER_SIZE, JUMP_VELOCITY, GRAVITY, TERMINAL_VELOCITY, PLAYER_SPEED } = require('./levels');
const { buildObjects, createPlayer, resolveMovement, applyPendingMove, advanceMovingPlatforms } = require('./physics');

// Deterministic PRNG so the same tower id always regenerates the same layout.
function mulberry32(seed) {
    let s = seed | 0;
    return function () {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const WALL_COLOR = 0x0000ff;
const PALETTE = [0x2ecc71, 0x3498db, 0xf1c40f, 0xe74c3c, 0x9b59b6, 0x1abc9c];
const KILL_COLOR = 0xff0000;

function walls() {
    return [
        { x: 0, y: TOWER_HEIGHT / 2, z: GROUND_AREA / 2 - 0.5, width: GROUND_AREA, height: TOWER_HEIGHT, depth: 1, color: WALL_COLOR },
        { x: 0, y: TOWER_HEIGHT / 2, z: -GROUND_AREA / 2 + 0.5, width: GROUND_AREA, height: TOWER_HEIGHT, depth: 1, color: WALL_COLOR },
        { x: -GROUND_AREA / 2 + 0.5, y: TOWER_HEIGHT / 2, z: 0, width: 1, height: TOWER_HEIGHT, depth: GROUND_AREA, color: WALL_COLOR },
        { x: GROUND_AREA / 2 - 0.5, y: TOWER_HEIGHT / 2, z: 0, width: 1, height: TOWER_HEIGHT, depth: GROUND_AREA, color: WALL_COLOR },
    ];
}

function pick(rand, arr) {
    return arr[Math.floor(rand() * arr.length)];
}

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

function rotate(dir, radians) {
    const c = Math.cos(radians), s = Math.sin(radians);
    return { x: dir.x * c - dir.z * s, z: dir.x * s + dir.z * c };
}

function towardCenter(from) {
    const d = Math.hypot(from.x, from.z);
    if (d < 0.01) return { x: 1, z: 0 };
    return { x: -from.x / d, z: -from.z / d };
}

// Near a wall, only a narrow slice of directions has room to clamp-free
// land; picking a fully random angle there mostly produces truncated,
// unreachable candidates. Once `from` is close enough to the boundary, bias
// the angle toward the center instead of sampling uniformly.
function biasedAngle(rand, from, margin) {
    const edgeDist = margin - Math.max(Math.abs(from.x), Math.abs(from.z));
    if (edgeDist > margin * 0.35) return rand() * Math.PI * 2;
    const center = towardCenter(from);
    const centerAngle = Math.atan2(center.z, center.x);
    return centerAngle + (rand() * 2 - 1) * Math.PI * 0.55;
}

// --- Real-physics jump verification ---
// Distance/height heuristics alone can't catch every failure mode — e.g. a
// long rail-shaped platform can act as a "ceiling" that blocks the rising
// half of a jump before the player clears it horizontally, even when the raw
// distance and height are individually well within jump range, and a
// platform verified safe against everything placed *before* it can still get
// boxed in by something placed *after* it nearby. So every jump is simulated
// against the real physics engine (the same resolveMovement/applyPendingMove
// the game itself runs) against the tower's *final* geometry, and any jump
// that doesn't actually land gets its platform regenerated and re-checked
// until the whole climb verifiably works.

function topY(p) {
    if (p.shape === 'sphere' || p.shape === 'cylinder') return p.y + p.radius;
    return p.y + (p.height || 0.5) / 2;
}

function simulateJump(objects, from, to, maxTicks) {
    const player = createPlayer();
    player.position = { x: from.x, y: topY(from) + PLAYER_SIZE.height / 2, z: from.z };
    player.y_vel = 0;
    player.on_ground = true;

    const dx = to.x - from.x, dz = to.z - from.z;
    const dist = Math.hypot(dx, dz) || 1;
    player.angleY = Math.atan2(-dx / dist, -dz / dist);

    let landedTicks = 0;
    let everAirborne = false;
    for (let t = 0; t < maxTicks; t++) {
        const keys = { w: true, a: false, s: false, d: false, jump: t === 0, down: false };
        advanceMovingPlatforms(objects);
        resolveMovement(player, objects, keys, []);
        applyPendingMove(player, objects);
        if (player.dead) return false; // hit a hazard
        if (!player.on_ground) everAirborne = true;
        // A real jump leaves the ground almost immediately — if it hasn't by
        // now, something (usually a ceiling) blocked it outright; stop early
        // instead of burning the rest of the tick budget.
        if (t === 5 && !everAirborne) return false;

        const dxNow = player.position.x - to.x, dzNow = player.position.z - to.z;
        // player.position.y is the player's *center*, which sits half its
        // height above the surface it's standing on — compare against that,
        // not the bare platform surface height, or a perfect landing never
        // registers as "on target".
        const onTarget = Math.hypot(dxNow, dzNow) < 1.1 && Math.abs(player.position.y - (topY(to) + PLAYER_SIZE.height / 2)) < 0.6;
        if (player.on_ground && onTarget) {
            landedTicks++;
            if (landedTicks >= 3) return true;
        } else {
            landedTicks = 0;
        }

        if (player.position.y < Math.min(topY(from), topY(to)) - 15) return false; // fell through
    }
    return false;
}

function simulateRide(objects, movingPlatform, maxTicks) {
    const player = createPlayer();
    player.position = { x: movingPlatform.startPos.x, y: movingPlatform.y + 0.5 + PLAYER_SIZE.height / 2, z: movingPlatform.startPos.z };
    player.y_vel = 0;
    player.on_ground = true;
    const keys = { w: false, a: false, s: false, d: false, jump: false, down: false };
    for (let t = 0; t < maxTicks; t++) {
        advanceMovingPlatforms(objects);
        resolveMovement(player, objects, keys, []);
        applyPendingMove(player, objects);
        const d = Math.hypot(player.position.x - movingPlatform.endPos.x, player.position.z - movingPlatform.endPos.z);
        if (d < 1.5) return true;
    }
    return false;
}

// A jump's horizontal reach isn't a free choice independent of how high it
// rises — the arc only crosses back down through a given height `dy` at one
// specific horizontal distance (for a fixed forward speed and jump impulse).
// Landing anywhere but at (approximately) that distance means the platform
// is either still ahead of the player when they've already fallen past its
// height, or already behind them. So candidate distances are derived from
// the actual per-tick vertical physics (mirroring resolveMovement exactly),
// not picked independently at random.
function jumpDescentDist(dy) {
    let yv = JUMP_VELOCITY;
    let y = 0;
    let ticks = 0;
    while (ticks < 500) {
        yv -= GRAVITY;
        if (yv < TERMINAL_VELOCITY) yv = TERMINAL_VELOCITY;
        y += yv;
        ticks++;
        if (yv < 0 && y <= dy) break;
    }
    return ticks * PLAYER_SPEED;
}
// Small random slack around the physically-correct distance, kept well
// inside simulateJump's landing tolerance so it doesn't itself cause misses.
const JUMP_DIST_JITTER = 0.2;
const JUMP_DY_MIN = 0.7, JUMP_DY_MAX = 1.8;
const RIDE_DIST_MIN = 3, RIDE_DIST_MAX = 6;
// A jump that clamps to near-zero horizontal distance (pinned against a wall)
// is unreachable in this engine — the target ends up directly overhead, and
// the player clips its underside before ever getting horizontal clearance to
// land on top.
const MIN_EFFECTIVE_DIST = 0.8;
const RANDOM_ATTEMPTS = 12;
// Platforms packed too close together (even if each individual jump verifies)
// tend to box each other in — a long random walk with capped step sizes can
// otherwise get stuck oscillating in one small column. Reject candidates that
// land too near any *other* existing platform in a similar height band.
const CLUTTER_MIN_DIST = 2.5;
const CLUTTER_Y_BAND = 2.5;

function isTooCluttered(x, y, z, from, otherEntries) {
    for (const o of otherEntries) {
        if (o === from) continue;
        if ((o.width && o.width > 10) || (o.depth && o.depth > 10)) continue; // walls
        if (Math.abs(o.y - y) > CLUTTER_Y_BAND) continue;
        if (Math.hypot(o.x - x, o.z - z) < CLUTTER_MIN_DIST) return true;
    }
    return false;
}

// A moving platform's ride can be obstructed by something sitting anywhere
// along its travel line, not just at the two endpoints — sample a handful of
// points between start and end and clutter-check each.
function isRideObstructed(startPos, endPos, from, otherEntries) {
    const SAMPLES = 4;
    for (let s = 1; s <= SAMPLES; s++) {
        const t = s / (SAMPLES + 1);
        const x = startPos.x + (endPos.x - startPos.x) * t;
        const z = startPos.z + (endPos.z - startPos.z) * t;
        if (isTooCluttered(x, startPos.y, z, from, otherEntries)) return true;
    }
    return false;
}

function shapedPlatform(rand, x, y, z) {
    const shape = pick(rand, ['box', 'sphere', 'cylinder', 'triangle']);
    const color = pick(rand, PALETTE);
    const p = { x, y, z, color };
    if (shape === 'box') Object.assign(p, { shape: 'box', width: 1 + rand() * 0.8, height: 0.5, depth: 1 + rand() * 0.8 });
    else if (shape === 'sphere') Object.assign(p, { shape: 'sphere', radius: 0.5 + rand() * 0.4, height: 0.5 });
    else if (shape === 'cylinder') Object.assign(p, { shape: 'cylinder', radius: 0.3, length: 1.2 + rand() * 1.3, axis: rand() < 0.5 ? 'x' : 'z' });
    else Object.assign(p, { shape: 'triangle', size: 1 + rand() * 0.8, height: 0.5 });
    return p;
}

// Random dist/angle/dy candidates first, then a handful of short verified
// hops toward the tower's center (which always has room to move into) if
// nothing else lands — checked against `otherObjects`, the *rest* of the
// tower's geometry, so this is valid regardless of generation order.
function pickJumpTarget(rand, margin, from, otherObjects) {
    for (let attempt = 0; attempt < RANDOM_ATTEMPTS; attempt++) {
        const angle = biasedAngle(rand, from, margin);
        const dy = JUMP_DY_MIN + rand() * (JUMP_DY_MAX - JUMP_DY_MIN);
        const dist = jumpDescentDist(dy) + (rand() * 2 - 1) * JUMP_DIST_JITTER;
        const nx = clamp(from.x + Math.cos(angle) * dist, -margin, margin);
        const nz = clamp(from.z + Math.sin(angle) * dist, -margin, margin);
        if (Math.hypot(nx - from.x, nz - from.z) < MIN_EFFECTIVE_DIST) continue;
        if (isTooCluttered(nx, from.y + dy, nz, from, otherObjects)) continue;
        const candidate = shapedPlatform(rand, nx, from.y + dy, nz);
        if (simulateJump(buildObjects(otherObjects.concat([candidate])), from, candidate, 45)) return candidate;
    }

    // Exhaustive, still-verified fallback: every 22.5-degree direction crossed
    // with a spread of dy levels (each with its physically-correct distance).
    // Unlike the random phase above, nothing here is left unverified — a
    // candidate is only ever returned once simulateJump confirms it lands.
    const center = towardCenter(from);
    const dirs = [];
    for (let k = 0; k < 16; k++) dirs.push(rotate(center, (k * Math.PI) / 8));
    const dyLevels = [0.8, 1.0, 1.2, 1.4, 1.6, 0.7, 1.8, 0.75];
    for (const dy of dyLevels) {
        const dist = jumpDescentDist(dy);
        for (const dir of dirs) {
            const nx = clamp(from.x + dir.x * dist, -margin, margin);
            const nz = clamp(from.z + dir.z * dist, -margin, margin);
            if (Math.hypot(nx - from.x, nz - from.z) < MIN_EFFECTIVE_DIST) continue;
            if (isTooCluttered(nx, from.y + dy, nz, from, otherObjects)) continue;
            const candidate = { x: nx, y: from.y + dy, z: nz, shape: 'box', width: 1.6, height: 0.5, depth: 1.6, color: pick(rand, PALETTE) };
            if (simulateJump(buildObjects(otherObjects.concat([candidate])), from, candidate, 60)) return candidate;
        }
    }
    // Truly should be unreachable — 128 direction/height combos above are all
    // physics-verified, so this only fires if `from` is almost entirely boxed
    // in. Still clutter-checked (never dropped inside/under something the
    // player's own standing height would already overlap) even though it
    // isn't jump-verified, so it can't trap the player outright.
    for (const dy of dyLevels) {
        const dist = jumpDescentDist(dy);
        for (const dir of dirs) {
            const nx = clamp(from.x + dir.x * dist, -margin, margin);
            const nz = clamp(from.z + dir.z * dist, -margin, margin);
            if (Math.hypot(nx - from.x, nz - from.z) < MIN_EFFECTIVE_DIST) continue;
            if (isTooCluttered(nx, from.y + dy, nz, from, otherObjects)) continue;
            return { x: nx, y: from.y + dy, z: nz, shape: 'box', width: 1.6, height: 0.5, depth: 1.6, color: pick(rand, PALETTE) };
        }
    }
    const fallbackDy = 0.8, fallbackDist = jumpDescentDist(fallbackDy);
    const nx = clamp(from.x + center.x * fallbackDist, -margin, margin);
    const nz = clamp(from.z + center.z * fallbackDist, -margin, margin);
    return { x: nx, y: from.y + fallbackDy, z: nz, shape: 'box', width: 1.6, height: 0.5, depth: 1.6, color: pick(rand, PALETTE) };
}

function pickMovingTarget(rand, margin, from, otherObjects) {
    for (let attempt = 0; attempt < RANDOM_ATTEMPTS; attempt++) {
        const angle = biasedAngle(rand, from, margin);
        const dy = JUMP_DY_MIN + rand() * (JUMP_DY_MAX - JUMP_DY_MIN);
        const jumpDist = jumpDescentDist(dy) + (rand() * 2 - 1) * JUMP_DIST_JITTER;
        const nx = clamp(from.x + Math.cos(angle) * jumpDist, -margin, margin);
        const nz = clamp(from.z + Math.sin(angle) * jumpDist, -margin, margin);
        if (Math.hypot(nx - from.x, nz - from.z) < MIN_EFFECTIVE_DIST) continue;
        const ny = from.y + dy;
        if (isTooCluttered(nx, ny, nz, from, otherObjects)) continue;
        const rideDist = RIDE_DIST_MIN + rand() * (RIDE_DIST_MAX - RIDE_DIST_MIN);
        const rideAngle = angle + (rand() * 2 - 1) * (Math.PI / 3);
        const ex = clamp(nx + Math.cos(rideAngle) * rideDist, -margin, margin);
        const ez = clamp(nz + Math.sin(rideAngle) * rideDist, -margin, margin);
        if (isTooCluttered(ex, ny, ez, from, otherObjects)) continue;
        if (isRideObstructed({ x: nx, y: ny, z: nz }, { x: ex, y: ny, z: ez }, from, otherObjects)) continue;

        const candidate = {
            x: nx, y: ny, z: nz, shape: 'box', width: 2, height: 0.5, depth: 2,
            special: 'moving', color: 0x1abc9c,
            startPos: { x: nx, y: ny, z: nz }, endPos: { x: ex, y: ny, z: ez },
        };
        const objects = buildObjects(otherObjects.concat([candidate]));
        if (!simulateJump(objects, from, candidate, 45)) continue;
        if (!simulateRide(objects, candidate, 120)) continue;
        return candidate;
    }
    return null; // caller falls back to a regular jump instead
}

// Fast heuristic first pass: walk a random path upward, dropping a platform
// at each step using the safe distance/height ranges (no simulation yet —
// verification happens in a second pass against the tower's final geometry).
function layoutPath(rand, margin) {
    const path = [];
    const hazards = [];

    let cur = { x: 0, y: 2, z: 6 };
    path.push({ ...cur, shape: 'box', width: 1.5, height: 0.5, depth: 1.5, color: pick(rand, PALETTE) });

    while (cur.y < TOWER_HEIGHT - 4) {
        const roll = rand();
        const angle = biasedAngle(rand, cur, margin);
        const dy = JUMP_DY_MIN + rand() * (JUMP_DY_MAX - JUMP_DY_MIN);

        if (roll < 0.15 && path.length > 3) {
            const dist = 1.5 + rand();
            const nx = clamp(cur.x + Math.cos(angle) * dist, -margin, margin);
            const nz = clamp(cur.z + Math.sin(angle) * dist, -margin, margin);
            hazards.push({ x: nx, y: cur.y + 0.6 + rand() * 0.6, z: nz, shape: 'cylinder', radius: 0.3, length: 1.5, special: 'kill', color: KILL_COLOR });
            continue;
        }

        if (roll < 0.3) {
            const jumpDist = jumpDescentDist(dy) + (rand() * 2 - 1) * JUMP_DIST_JITTER;
            const nx = clamp(cur.x + Math.cos(angle) * jumpDist, -margin, margin);
            const nz = clamp(cur.z + Math.sin(angle) * jumpDist, -margin, margin);
            const ny = cur.y + dy;
            const rideDist = RIDE_DIST_MIN + rand() * (RIDE_DIST_MAX - RIDE_DIST_MIN);
            const rideAngle = angle + (rand() * 2 - 1) * (Math.PI / 3);
            const ex = clamp(nx + Math.cos(rideAngle) * rideDist, -margin, margin);
            const ez = clamp(nz + Math.sin(rideAngle) * rideDist, -margin, margin);
            path.push({
                x: nx, y: ny, z: nz, shape: 'box', width: 2, height: 0.5, depth: 2,
                special: 'moving', color: 0x1abc9c,
                startPos: { x: nx, y: ny, z: nz }, endPos: { x: ex, y: ny, z: ez },
            });
            cur = { x: ex, y: ny, z: ez };
            continue;
        }

        const dist = jumpDescentDist(dy) + (rand() * 2 - 1) * JUMP_DIST_JITTER;
        const nx = clamp(cur.x + Math.cos(angle) * dist, -margin, margin);
        const nz = clamp(cur.z + Math.sin(angle) * dist, -margin, margin);
        const ny = cur.y + dy;
        path.push(shapedPlatform(rand, nx, ny, nz));
        cur = { x: nx, y: ny, z: nz };
    }

    path.push({ x: cur.x, y: TOWER_HEIGHT - 2, z: cur.z, shape: 'box', width: 5, height: 0.5, depth: 5, color: 0xf1c40f });
    return { path, hazards };
}

// Where a player stands right before attempting the jump to path[i] — the
// platform itself for a regular stop, or wherever the ride drops them off.
function takeoffPoint(prevEntry) {
    if (prevEntry.special === 'moving') return { x: prevEntry.endPos.x, y: prevEntry.y, z: prevEntry.endPos.z };
    return prevEntry;
}

// Re-verifies every jump against the tower's *final* geometry (all platforms,
// not just ones placed earlier) and regenerates any platform whose jump
// doesn't actually land, until the whole climb passes or the retry budget
// for that step runs out.
function repairPath(rand, margin, path, hazards) {
    const MAX_REPAIRS_PER_STEP = 6;
    // A repair to one step can change geometry that an *earlier* step's jump
    // was already verified against (repairing step i only re-checks i and
    // everything after it in this pass), so a single forward sweep isn't
    // enough to guarantee global consistency. Keep sweeping until a full
    // pass makes no changes (i.e. every jump is simultaneously valid against
    // the tower's current, final geometry).
    const MAX_PASSES = 15;

    for (let pass = 0; pass < MAX_PASSES; pass++) {
        let anyRepaired = false;
        for (let i = 1; i < path.length; i++) {
            for (let repair = 0; repair < MAX_REPAIRS_PER_STEP; repair++) {
                const from = takeoffPoint(path[i - 1]);
                const to = path[i];
                const otherObjects = walls().concat(path.filter((_, idx) => idx !== i), hazards);
                const objects = buildObjects(otherObjects.concat([to]));

                const jumpOk = simulateJump(objects, from, to, 60);
                const rideOk = to.special !== 'moving' || simulateRide(objects, to, 120);
                if (jumpOk && rideOk) break;

                anyRepaired = true;
                path[i] = to.special === 'moving'
                    ? (pickMovingTarget(rand, margin, from, otherObjects) || pickJumpTarget(rand, margin, from, otherObjects))
                    : pickJumpTarget(rand, margin, from, otherObjects);
            }
        }
        if (!anyRepaired) break;
    }
    return path;
}

// Kill hazards are solid obstacles to the physics engine, not just
// touch-triggers (resolveMovement collides against every object, including
// `special: 'kill'` ones) — so an unchecked hazard placed near a climbing
// platform can silently trap or block a jump exactly like a "ceiling" would.
// Hazards are decorative and never load-bearing, so any that ended up too
// close to the actual climbing path are simply dropped rather than repaired.
const HAZARD_CLEARANCE = 1.6;
const HAZARD_Y_BAND = 2.0;
function sanitizeHazards(path, hazards) {
    return hazards.filter((hz) => !path.some((p) =>
        Math.abs(p.y - hz.y) <= HAZARD_Y_BAND && Math.hypot(p.x - hz.x, p.z - hz.z) < HAZARD_CLEARANCE
    ));
}

function generateTower(seed) {
    const rand = mulberry32(seed);
    const margin = GROUND_AREA / 2 - 2;
    const { path, hazards: rawHazards } = layoutPath(rand, margin);
    const hazards = sanitizeHazards(path, rawHazards);
    const fixedPath = repairPath(rand, margin, path, hazards);
    return walls().concat(fixedPath, hazards);
}

const TOWER_POOL = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, name: `Tower ${i + 1}`, seed: (i + 1) * 7919 }));

const towerLevelCache = new Map();

function buildTowerLevel(towerId) {
    if (towerLevelCache.has(towerId)) return towerLevelCache.get(towerId);
    const meta = TOWER_POOL.find((t) => t.id === towerId) || TOWER_POOL[0];
    const lvl = generateTower(meta.seed);
    towerLevelCache.set(towerId, lvl);
    return lvl;
}

// Every tower is verified and cached once up front, at server startup, rather
// than the first time a room happens to request it (which would otherwise
// briefly stall handling requests while a tower's jumps get simulated).
for (const t of TOWER_POOL) buildTowerLevel(t.id);

function randomTowerId() {
    return TOWER_POOL[Math.floor(Math.random() * TOWER_POOL.length)].id;
}

function randomTowerChoices(n) {
    const pool = TOWER_POOL.slice();
    const picks = [];
    for (let i = 0; i < n && pool.length; i++) {
        const idx = Math.floor(Math.random() * pool.length);
        picks.push(pool.splice(idx, 1)[0]);
    }
    return picks;
}

module.exports = { TOWER_POOL, buildTowerLevel, randomTowerId, randomTowerChoices, simulateJump, simulateRide, topY };
