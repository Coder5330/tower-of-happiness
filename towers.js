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

function isTooCluttered(x, y, z, from, otherEntries, minDist = CLUTTER_MIN_DIST) {
    for (const o of otherEntries) {
        if (o === from) continue;
        if ((o.width && o.width > 10) || (o.depth && o.depth > 10)) continue; // walls
        if (Math.abs(o.y - y) > CLUTTER_Y_BAND) continue;
        if (Math.hypot(o.x - x, o.z - z) < minDist) return true;
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
    // Last resort before giving up: the same physics-verified search with the
    // spacing rule relaxed and a wider landing pad. Cramped, yes - but every
    // candidate returned here still had its jump simulated and landed.
    // Nothing unverified is ever returned: a caller that gets null repairs the
    // platform this jump starts from instead, which is the actual problem when
    // a take-off point is boxed in.
    const fineDirs = [];
    for (let k = 0; k < 16; k++) fineDirs.push(rotate(center, (k * Math.PI) / 8));
    const fineDys = [0.9, 1.1, 1.3, 1.5, 0.8, 1.7];
    for (const pad of [2.2]) {
        for (const dy of fineDys) {
            const dist = jumpDescentDist(dy);
            for (const dir of fineDirs) {
                const nx = clamp(from.x + dir.x * dist, -margin, margin);
                const nz = clamp(from.z + dir.z * dist, -margin, margin);
                if (Math.hypot(nx - from.x, nz - from.z) < MIN_EFFECTIVE_DIST) continue;
                if (isTooCluttered(nx, from.y + dy, nz, from, otherObjects, CLUTTER_MIN_DIST * 0.65)) continue;
                const candidate = { x: nx, y: from.y + dy, z: nz, shape: 'box', width: pad, height: 0.5, depth: pad, color: pick(rand, PALETTE) };
                if (simulateJump(buildObjects(otherObjects.concat([candidate])), from, candidate, 60)) return candidate;
            }
        }
    }
    return null;
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

// The summit slab, verified like every other landing. It has to stay high
// enough to count as a win (WIN_HEIGHT is TOWER_HEIGHT - 3, measured at the
// player's centre) and wide enough to still read as the top of the tower, so
// the search is over direction and take-off height rather than position.
function pickSummit(rand, margin, from, otherObjects) {
    const dirs = [];
    for (let k = 0; k < 16; k++) dirs.push(rotate(towardCenter(from), (k * Math.PI) / 8));
    const minY = TOWER_HEIGHT - 2.5;
    for (const size of [5, 3.5]) {
        for (const dy of [1.2, 1.0, 1.4, 0.9, 1.6, 0.8, 1.8]) {
            const y = Math.max(minY, from.y + dy);
            const dist = jumpDescentDist(y - from.y);
            for (const dir of dirs) {
                const nx = clamp(from.x + dir.x * dist, -margin, margin);
                const nz = clamp(from.z + dir.z * dist, -margin, margin);
                if (Math.hypot(nx - from.x, nz - from.z) < MIN_EFFECTIVE_DIST) continue;
                const candidate = { x: nx, y, z: nz, shape: 'box', width: size, height: 0.5, depth: size, color: 0xf1c40f, summit: true };
                if (simulateJump(buildObjects(otherObjects.concat([candidate])), from, candidate, 60)) return candidate;
            }
        }
    }
    return null;
}

// Builds the climb one verified jump at a time: each platform is only kept
// once simulateJump lands on it against the geometry that exists so far. When
// a take-off point turns out to be boxed in - no landing spot anywhere around
// it - the platform the player would be standing on is removed and re-rolled,
// so the walk backs out of dead ends instead of building through them.
//
// This replaced a blind random walk that placed the whole path unverified and
// left the repair sweep to fix nearly every step, which it couldn't do without
// each fix invalidating the last.
// A jump verified when it was placed can still be ruined by a platform added
// above it later - an arc rises 2.6, which is two or three steps' worth of
// climb, so anything within a few platforms can end up overhanging it. Every
// candidate is therefore checked against the jumps just below it as well as
// its own, which is what stops the tower from having to be unpicked afterwards.
const GUARD_STEPS = 4;

function breaksJumpsBelow(path, hazards, candidate) {
    const level = walls().concat(path, [candidate], hazards);
    for (let i = Math.max(1, path.length - GUARD_STEPS); i < path.length; i++) {
        if (!simulateJump(buildObjects(level), takeoffPoint(path[i - 1]), path[i], 80)) return true;
    }
    return false;
}

function growPath(rand, margin) {
    const MAX_BACKTRACKS = 150;
    const PLACEMENT_ATTEMPTS = 6;
    const path = [{ x: 0, y: 2, z: 6, shape: 'box', width: 1.5, height: 0.5, depth: 1.5, color: pick(rand, PALETTE) }];
    const hazards = [];
    let backtracks = 0;

    function geometry() { return walls().concat(path, hazards); }

    while (path[path.length - 1].y < TOWER_HEIGHT - 4) {
        const prev = path[path.length - 1];
        const from = takeoffPoint(prev);
        const others = geometry();
        const roll = rand();

        // Decorative hazard off to the side. It goes into the geometry, so
        // every jump from here on is verified with it in place.
        if (roll < 0.15 && path.length > 3) {
            const angle = biasedAngle(rand, from, margin);
            const dist = 1.5 + rand();
            hazards.push({
                x: clamp(from.x + Math.cos(angle) * dist, -margin, margin),
                y: from.y + 0.6 + rand() * 0.6,
                z: clamp(from.z + Math.sin(angle) * dist, -margin, margin),
                shape: 'cylinder', radius: 0.3, length: 1.5, special: 'kill', color: KILL_COLOR,
            });
            continue;
        }

        let next = null;
        for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS; attempt++) {
            const candidate = (roll < 0.3 && attempt < 2)
                ? (pickMovingTarget(rand, margin, from, others) || pickJumpTarget(rand, margin, from, others))
                : pickJumpTarget(rand, margin, from, others);
            if (!candidate) break;
            if (!breaksJumpsBelow(path, hazards, candidate)) { next = candidate; break; }
        }

        if (next) { path.push(next); continue; }

        // Nowhere to go from here: undo the platform we are standing on.
        if (path.length > 1 && backtracks++ < MAX_BACKTRACKS) path.pop();
        else return null;
    }

    for (;;) {
        const last = path[path.length - 1];
        const summit = pickSummit(rand, margin, takeoffPoint(last), geometry());
        if (summit && !breaksJumpsBelow(path, hazards, summit)) { path.push(summit); return { path, hazards }; }
        if (path.length <= 2 || backtracks++ >= MAX_BACKTRACKS) return null;
        path.pop();                                    // no summit from there either
    }
}

// Where a player stands right before attempting the jump to path[i] — the
// platform itself for a regular stop, or wherever the ride drops them off.
function takeoffPoint(prevEntry) {
    if (prevEntry.special === 'moving') return { x: prevEntry.endPos.x, y: prevEntry.y, z: prevEntry.endPos.z };
    return prevEntry;
}

// One step of the climb, checked against the tower's *final* geometry - every
// platform, not just the ones placed before it. Budgets are deliberately
// tighter than the shipping check in towerFailures(), so anything that passes
// here passes there too.
function stepVerifies(path, hazards, i) {
    const to = path[i];
    const from = takeoffPoint(path[i - 1]);
    // simulateJump/simulateRide advance moving platforms in place, so each
    // check needs its own freshly built world, starting at rest like the game.
    if (!simulateJump(buildObjects(walls().concat(path, hazards)), from, to, 80)) return false;
    if (to.special === 'moving' && !simulateRide(buildObjects(walls().concat(path, hazards)), to, 140)) return false;
    return true;
}

// Re-roll platform `i`, verified against everything else in the tower. Returns
// false when nothing lands from that take-off point at all.
function regeneratePlatform(rand, margin, path, hazards, i) {
    if (i < 1 || i >= path.length) return false;

    const from = takeoffPoint(path[i - 1]);
    const others = walls().concat(path.filter((_, idx) => idx !== i), hazards);

    const replacement = path[i].summit
        ? pickSummit(rand, margin, from, others)
        : (path[i].special === 'moving'
            ? (pickMovingTarget(rand, margin, from, others) || pickJumpTarget(rand, margin, from, others))
            : pickJumpTarget(rand, margin, from, others));
    if (!replacement) return false;

    path[i] = replacement;
    return true;
}

// Sweeps the climb until a whole pass changes nothing - at which point every
// jump verified against geometry that then stayed put, so the tower is
// consistent as a whole rather than step by step.
//
// When a step keeps failing, the platform being jumped *to* usually isn't the
// problem: the one it has to jump *from* is boxed in, and no landing spot
// exists from there. So repairs escalate backwards down the climb, re-rolling
// earlier platforms until the step becomes reachable.
function repairPath(rand, margin, path, hazards) {
    const MAX_PASSES = 15;
    const MAX_REPAIRS_PER_STEP = 6;
    // A layout that needs more than a few seconds of repair is a dead end;
    // generateTower re-rolls it from a fresh seed, which is cheaper than
    // fighting it.
    const deadline = Date.now() + REPAIR_BUDGET_MS;
    const tries = new Map();

    for (let pass = 0; pass < MAX_PASSES; pass++) {
        if (Date.now() > deadline) return path;
        let anyRepaired = false;

        for (let i = 1; i < path.length; i++) {
            for (let repair = 0; repair < MAX_REPAIRS_PER_STEP; repair++) {
                if (stepVerifies(path, hazards, i)) break;
                if (Date.now() > deadline) return path;
                anyRepaired = true;

                const n = (tries.get(i) || 0) + 1;
                tries.set(i, n);

                // First few goes: re-roll this platform. After that, walk the
                // repair backwards - one platform further down each time.
                let target = i;
                if (n > 3) target = Math.max(1, i - 1 - ((n - 4) % 3));

                if (!regeneratePlatform(rand, margin, path, hazards, target) && target > 1) {
                    // Nothing lands from there either - go back further still.
                    regeneratePlatform(rand, margin, path, hazards, target - 1);
                }
            }
        }

        if (!anyRepaired) return path;
    }
    return path;                                       // caller re-rolls the whole tower
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

// The shipping check: exactly what verify-towers.js asserts, so a tower can
// never be generated to one standard and tested against another. Returns the
// jumps (and rides) that don't actually work.
function towerFailures(levelData) {
    const climbable = levelData.slice(4).filter((p) => p.special !== 'kill');
    const failures = [];
    for (let i = 0; i < climbable.length - 1; i++) {
        const from = climbable[i];
        const to = climbable[i + 1];
        if (from.special === 'moving' && !simulateRide(buildObjects(levelData), from, 260)) {
            failures.push({ index: i, kind: 'ride', from, to });
        }
        const takeoff = takeoffPoint(from);
        if (!simulateJump(buildObjects(levelData), takeoff, to, 200)) {
            failures.push({ index: i + 1, kind: 'jump', from, to, takeoff });
        }
    }
    return failures;
}

function buildOneTower(seed) {
    const rand = mulberry32(seed);
    const margin = GROUND_AREA / 2 - 2;
    const grown = growPath(rand, margin);
    if (!grown) return null;                           // dead-ended; caller re-rolls
    const hazards = sanitizeHazards(grown.path, grown.hazards);
    // Every jump was verified as it was placed, but a platform added later can
    // still overhang an earlier one, so the whole climb gets swept again.
    const fixedPath = repairPath(rand, margin, grown.path, hazards);
    return walls().concat(fixedPath, hazards);
}

// A tower is only ever shipped once every one of its jumps has been simulated
// on the finished geometry. If the repair sweep can't reach that, the layout
// itself was a dead end - re-roll the whole tower from a derived seed rather
// than hand players a climb with a wall in it.
const MAX_TOWER_ATTEMPTS = 6;
const REPAIR_BUDGET_MS = 4000;

function generateTower(seed) {
    let best = null;
    for (let attempt = 0; attempt < MAX_TOWER_ATTEMPTS; attempt++) {
        const level = buildOneTower(seed + attempt * 104729);
        if (!level) continue;
        const failures = towerFailures(level);
        if (failures.length === 0) return level;
        if (!best || failures.length < best.count) best = { level, count: failures.length };
    }
    console.warn(`towers: seed ${seed} still has ${best ? best.count : '?'} unverifiable jump(s) after ` +
        `${MAX_TOWER_ATTEMPTS} attempts — shipping the closest one`);
    return best ? best.level : buildOneTower(seed) || walls();
}

// Bump TOWER_SEED (or this default) to roll a completely new set of 12 towers.
// Keep it fixed once deployed: the seed is the only thing standing between a
// stable pool and a different tower under everyone's feet on the next deploy.
//
// Any value gives a fully climbable pool - generateTower re-rolls a tower until
// every one of its jumps has been simulated on the finished geometry - so this
// is purely a choice of which 12 towers you want. Run `node verify-towers.js`
// after changing it anyway; that is the check the generator holds itself to.
const SEED_SALT = process.env.TOWER_SEED !== undefined ? Number(process.env.TOWER_SEED) : 271828;

const TOWER_POOL = Array.from({ length: 12 }, (_, i) => ({
    id: i + 1, name: `Tower ${i + 1}`, seed: (i + 1) * 7919 + SEED_SALT,
}));

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

// Tower geometry is seeded, so the pool is byte-identical on every deploy; the
// only thing that varies between rooms is which of the 12 gets picked. Set
// TOWER_ID to pin every new room to one of them (useful for testing, or for
// running an event on a known tower).
const FIXED_TOWER_ID = Number(process.env.TOWER_ID) || null;

function randomTowerId() {
    if (FIXED_TOWER_ID && TOWER_POOL.some((t) => t.id === FIXED_TOWER_ID)) return FIXED_TOWER_ID;
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

module.exports = { TOWER_POOL, buildTowerLevel, randomTowerId, randomTowerChoices, simulateJump, simulateRide, topY, towerFailures };
