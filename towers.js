const fs = require('fs');
const path = require('path');
const { TOWER_HEIGHT, GROUND_AREA, PLAYER_SIZE, JUMP_VELOCITY, GRAVITY, TERMINAL_VELOCITY, PLAYER_SPEED } = require('./levels');
const { buildObjects, createPlayer, resolveMovement, applyPendingMove, advanceMovingPlatforms } = require('./physics');

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

function biasedAngle(rand, from, margin) {
    const edgeDist = margin - Math.max(Math.abs(from.x), Math.abs(from.z));
    if (edgeDist > margin * 0.35) return rand() * Math.PI * 2;
    const center = towardCenter(from);
    const centerAngle = Math.atan2(center.z, center.x);
    return centerAngle + (rand() * 2 - 1) * Math.PI * 0.55;
}

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
        if (player.dead) return false;
        if (!player.on_ground) everAirborne = true;
        if (t === 5 && !everAirborne) return false;

        const dxNow = player.position.x - to.x, dzNow = player.position.z - to.z;
        const onTarget = Math.hypot(dxNow, dzNow) < 1.1 && Math.abs(player.position.y - (topY(to) + PLAYER_SIZE.height / 2)) < 0.6;
        if (player.on_ground && onTarget) {
            landedTicks++;
            if (landedTicks >= 3) return true;
        } else {
            landedTicks = 0;
        }

        if (player.position.y < Math.min(topY(from), topY(to)) - 15) return false;
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
const JUMP_DIST_JITTER = 0.2;
const JUMP_DY_MIN = 0.7, JUMP_DY_MAX = 1.8;
const RIDE_DIST_MIN = 3, RIDE_DIST_MAX = 6;
const MIN_EFFECTIVE_DIST = 0.8;
const RANDOM_ATTEMPTS = 12;
const CLUTTER_MIN_DIST = 2.5;
const CLUTTER_Y_BAND = 2.5;

function isTooCluttered(x, y, z, from, otherEntries, minDist = CLUTTER_MIN_DIST) {
    for (const o of otherEntries) {
        if (o === from) continue;
        if ((o.width && o.width > 10) || (o.depth && o.depth > 10)) continue;
        if (Math.abs(o.y - y) > CLUTTER_Y_BAND) continue;
        if (Math.hypot(o.x - x, o.z - z) < minDist) return true;
    }
    return false;
}

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
    return null;
}

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

        // Every moving platform in a room runs on the exact same clock, so
        // jumping straight from one onto another can never actually work:
        // by the time a rider reaches the first one's far end, the second
        // has simultaneously reached its own far end too, never its near
        // one (where the jump was "verified" to land) — the fresh-build
        // check below can't see this, since it always resets every
        // platform to the start of its cycle. So a moving platform is only
        // ever placed after a regular (or standing-still) one.
        const canBeMoving = prev.special !== 'moving';
        let next = null;
        for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS; attempt++) {
            const candidate = (roll < 0.3 && attempt < 2 && canBeMoving)
                ? (pickMovingTarget(rand, margin, from, others) || pickJumpTarget(rand, margin, from, others))
                : pickJumpTarget(rand, margin, from, others);
            if (!candidate) break;
            if (!breaksJumpsBelow(path, hazards, candidate)) { next = candidate; break; }
        }

        if (next) { path.push(next); continue; }

        if (path.length > 1 && backtracks++ < MAX_BACKTRACKS) path.pop();
        else return null;
    }

    for (;;) {
        const last = path[path.length - 1];
        const summit = pickSummit(rand, margin, takeoffPoint(last), geometry());
        if (summit && !breaksJumpsBelow(path, hazards, summit)) { path.push(summit); return { path, hazards }; }
        if (path.length <= 2 || backtracks++ >= MAX_BACKTRACKS) return null;
        path.pop();
    }
}

function takeoffPoint(prevEntry) {
    if (prevEntry.special === 'moving') return { x: prevEntry.endPos.x, y: prevEntry.y, z: prevEntry.endPos.z };
    return prevEntry;
}

function stepVerifies(path, hazards, i) {
    const to = path[i];
    // A moving platform jumped to directly from another moving platform is
    // never actually reachable (see the note in growPath) — the ordinary
    // jump/ride simulation below can't detect that on its own, since it
    // always resets every platform to the start of its cycle, so it's
    // called out here explicitly as its own failure.
    if (to.special === 'moving' && path[i - 1].special === 'moving') return false;
    const from = takeoffPoint(path[i - 1]);
    if (!simulateJump(buildObjects(walls().concat(path, hazards)), from, to, 80)) return false;
    if (to.special === 'moving' && !simulateRide(buildObjects(walls().concat(path, hazards)), to, 140)) return false;
    return true;
}

function regeneratePlatform(rand, margin, path, hazards, i) {
    if (i < 1 || i >= path.length) return false;

    const from = takeoffPoint(path[i - 1]);
    const others = walls().concat(path.filter((_, idx) => idx !== i), hazards);
    const canBeMoving = path[i - 1].special !== 'moving';

    const replacement = path[i].summit
        ? pickSummit(rand, margin, from, others)
        : (path[i].special === 'moving' && canBeMoving
            ? (pickMovingTarget(rand, margin, from, others) || pickJumpTarget(rand, margin, from, others))
            : pickJumpTarget(rand, margin, from, others));
    if (!replacement) return false;

    path[i] = replacement;
    return true;
}

function repairPath(rand, margin, path, hazards) {
    const MAX_PASSES = 15;
    const MAX_REPAIRS_PER_STEP = 6;
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

                let target = i;
                if (n > 3) target = Math.max(1, i - 1 - ((n - 4) % 3));

                if (!regeneratePlatform(rand, margin, path, hazards, target) && target > 1) {
                    regeneratePlatform(rand, margin, path, hazards, target - 1);
                }
            }
        }

        if (!anyRepaired) return path;
    }
    return path;
}

const HAZARD_CLEARANCE = 1.6;
const HAZARD_Y_BAND = 2.0;
function sanitizeHazards(path, hazards) {
    return hazards.filter((hz) => !path.some((p) =>
        Math.abs(p.y - hz.y) <= HAZARD_Y_BAND && Math.hypot(p.x - hz.x, p.z - hz.z) < HAZARD_CLEARANCE
    ));
}

function towerFailures(levelData) {
    const climbable = levelData.slice(4).filter((p) => p.special !== 'kill');
    const failures = [];
    for (let i = 0; i < climbable.length - 1; i++) {
        const from = climbable[i];
        const to = climbable[i + 1];
        if (from.special === 'moving' && !simulateRide(buildObjects(levelData), from, 260)) {
            failures.push({ index: i, kind: 'ride', from, to });
        }
        // See the note in growPath: a moving platform jumped to directly
        // from another moving platform is never actually reachable, since
        // every moving platform in a room shares one global clock. This
        // wouldn't be caught by simulateJump below on its own, which
        // always resets every platform to the start of its cycle.
        if (to.special === 'moving' && from.special === 'moving') {
            failures.push({ index: i + 1, kind: 'chained-moving', from, to, takeoff: takeoffPoint(from) });
            continue;
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
    if (!grown) return null;
    const hazards = sanitizeHazards(grown.path, grown.hazards);
    const fixedPath = repairPath(rand, margin, grown.path, hazards);
    return walls().concat(fixedPath, hazards);
}

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

const SEED_SALT = process.env.TOWER_SEED !== undefined ? Number(process.env.TOWER_SEED) : 271828;

const TOWER_POOL = Array.from({ length: 12 }, (_, i) => ({
    id: i + 1, name: `Tower ${i + 1}`, seed: (i + 1) * 7919 + SEED_SALT,
}));

const towerLevelCache = new Map();

function loadBakedTowers() {
    if (process.env.TOWERS_REBUILD) return 0;
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'towers.json'), 'utf8'));
    } catch (err) {
        if (err.code !== 'ENOENT') console.warn('towers.json could not be read:', err.message);
        return 0;
    }
    if (!raw || raw.seed !== SEED_SALT || !Array.isArray(raw.towers)) {
        console.warn(`towers.json was built from seed ${raw && raw.seed} but this server runs ` +
            `seed ${SEED_SALT} — regenerating towers instead (run: npm run towers)`);
        return 0;
    }
    for (const tower of raw.towers) {
        if (Array.isArray(tower.level)) towerLevelCache.set(tower.id, tower.level);
    }
    return towerLevelCache.size;
}

function buildTowerLevel(towerId) {
    if (towerLevelCache.has(towerId)) return towerLevelCache.get(towerId);
    const meta = TOWER_POOL.find((t) => t.id === towerId) || TOWER_POOL[0];
    const lvl = generateTower(meta.seed);
    towerLevelCache.set(towerId, lvl);
    return lvl;
}

const bakedCount = loadBakedTowers();
if (bakedCount) console.log(`Loaded ${bakedCount} towers from towers.json`);

function warmTowerPool(onDone) {
    const pending = TOWER_POOL.filter((t) => !towerLevelCache.has(t.id));
    let i = 0;
    (function next() {
        if (i >= pending.length) {
            if (onDone) onDone(pending.length);
            return;
        }
        buildTowerLevel(pending[i++].id);
        setImmediate(next);
    })();
}

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

module.exports = {
    TOWER_POOL, SEED_SALT, buildTowerLevel, warmTowerPool, randomTowerId, randomTowerChoices,
    simulateJump, simulateRide, topY, towerFailures,
};
