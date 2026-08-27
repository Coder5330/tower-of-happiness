const { TOWER_HEIGHT, GROUND_AREA } = require('./levels');

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

// Walks a random path upward from near the ground to the top of the tower,
// dropping a jumpable platform at each step. Every tower id regenerates the
// same layout (seeded), but each id is a genuinely different climb.
function generateTower(seed) {
    const rand = mulberry32(seed);
    const margin = GROUND_AREA / 2 - 2;
    const platforms = [];

    let x = 0, y = 2, z = 6;
    platforms.push({ x, y, z, shape: 'box', width: 1.5, height: 0.5, depth: 1.5, color: pick(rand, PALETTE) });

    while (y < TOWER_HEIGHT - 4) {
        const roll = rand();
        const dy = 1 + rand() * 1.2;
        const angle = rand() * Math.PI * 2;

        if (roll < 0.15 && platforms.length > 3) {
            // Occasional hazard: a spike bridging the gap, gets in your way, not a stepping stone.
            const dist = 1.5 + rand();
            const nx = clamp(x + Math.cos(angle) * dist, -margin, margin);
            const nz = clamp(z + Math.sin(angle) * dist, -margin, margin);
            const ny = y + dy * 0.6;
            platforms.push({ x: nx, y: ny, z: nz, shape: 'cylinder', radius: 0.3, length: 1.5, special: 'kill', color: KILL_COLOR });
            continue; // hazards don't advance the path themselves
        }

        if (roll < 0.3) {
            // Moving platform — covers a bigger gap than a static jump could.
            const dist = 4 + rand() * 3;
            const nx = clamp(x + Math.cos(angle) * dist, -margin, margin);
            const nz = clamp(z + Math.sin(angle) * dist, -margin, margin);
            const ny = y + dy;
            const ex = clamp(nx + (rand() * 2 - 1) * 4, -margin, margin);
            const ez = clamp(nz + (rand() * 2 - 1) * 4, -margin, margin);
            platforms.push({
                x: nx, y: ny, z: nz, shape: 'box', width: 2, height: 0.5, depth: 2,
                special: 'moving', color: 0x1abc9c,
                startPos: { x: nx, y: ny, z: nz }, endPos: { x: ex, y: ny, z: ez },
            });
            x = nx; y = ny; z = nz;
            continue;
        }

        // Regular jumpable platform.
        const dist = 2 + rand() * 2.2;
        const nx = clamp(x + Math.cos(angle) * dist, -margin, margin);
        const nz = clamp(z + Math.sin(angle) * dist, -margin, margin);
        const ny = y + dy;
        const shape = pick(rand, ['box', 'sphere', 'cylinder', 'triangle']);
        const color = pick(rand, PALETTE);
        let p = { x: nx, y: ny, z: nz, color };
        if (shape === 'box') Object.assign(p, { shape: 'box', width: 1 + rand() * 0.8, height: 0.5, depth: 1 + rand() * 0.8 });
        else if (shape === 'sphere') Object.assign(p, { shape: 'sphere', radius: 0.5 + rand() * 0.4, height: 0.5 });
        else if (shape === 'cylinder') Object.assign(p, { shape: 'cylinder', radius: 0.3, length: 1.5 + rand() * 2.5, axis: rand() < 0.5 ? 'x' : 'z' });
        else Object.assign(p, { shape: 'triangle', size: 1 + rand() * 0.8, height: 0.5 });

        platforms.push(p);
        x = nx; y = ny; z = nz;
    }

    platforms.push({ x, y: TOWER_HEIGHT - 2, z, shape: 'box', width: 5, height: 0.5, depth: 5, color: 0xf1c40f });

    return walls().concat(platforms);
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

module.exports = { TOWER_POOL, buildTowerLevel, randomTowerId, randomTowerChoices };
