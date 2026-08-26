const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildObjects, advanceMovingPlatforms, createPlayer, resolveMovement, resolvePush, applyPendingMove, applyDismounts, respawnPlayer } = require('./physics');
const { level, SPAWN_POSITION, TOWER_HEIGHT, GROUND_AREA, PLAYER_SIZE } = require('./levels');

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME_TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const TICK_HZ = 60;
const TICK_MS = 1000 / TICK_HZ;
const BROADCAST_EVERY_N_TICKS = 2;

const objects = buildObjects();
const players = new Map();
let nextId = 1;
const freeIds = [];

const ADMIN_CODE = process.env.ADMIN_CODE || crypto.randomBytes(6).toString('hex');
if (!process.env.ADMIN_CODE) {
    console.log(`No ADMIN_CODE set — generated admin code for this run: ${ADMIN_CODE}`);
}

const AUTH_MAX_FAILS = 5;
const AUTH_LOCKOUT_MS = 30000;
const CHAT_MAX_LEN = 200;
const CHAT_MIN_INTERVAL_MS = 300;

const METEOR_RADIUS_MIN = 0.8;
const METEOR_RADIUS_MAX = 2;
const METEOR_SPEED_MIN = 0.2;
const METEOR_SPEED_MAX = 0.45;
const METEOR_SPAWN_MIN_MS = 200;
const METEOR_SPAWN_MAX_MS = 800;
const HOMING_CHANCE = 0.1;
const HOMING_SPEED_MULT = 10;
const NORMAL_WARN_SECONDS = 1.0;
const HOMING_WARN_SECONDS = 2.0;
const METEOR_SPAWN_Y = TOWER_HEIGHT + 15;
const METEOR_DESPAWN_Y = -5;
const METEOR_XZ_RANGE = GROUND_AREA / 2 - 1.5;
const GROUND_Y = 0;

const meteors = [];
const pendingExplosions = [];
let nextMeteorId = 1;
let ticksUntilMeteor = 1;

function randomBetween(min, max) {
    return min + Math.random() * (max - min);
}

function nextSpawnTicks() {
    return Math.max(1, Math.round(randomBetween(METEOR_SPAWN_MIN_MS, METEOR_SPAWN_MAX_MS) / TICK_MS));
}

function spawnMeteor() {
    const homing = Math.random() < HOMING_CHANCE;
    const radius = randomBetween(METEOR_RADIUS_MIN, METEOR_RADIUS_MAX);
    const speed = randomBetween(METEOR_SPEED_MIN, METEOR_SPEED_MAX) * (homing ? HOMING_SPEED_MULT : 1);
    const x = randomBetween(-METEOR_XZ_RANGE, METEOR_XZ_RANGE);
    const z = randomBetween(-METEOR_XZ_RANGE, METEOR_XZ_RANGE);
    const y = METEOR_SPAWN_Y;

    let vx = 0, vz = 0, vy = -speed;
    if (homing) {
        const targets = Array.from(players.values(), (e) => e.player).filter((p) => !(p.admin && p.admin.fly));
        if (targets.length) {
            const target = targets[Math.floor(Math.random() * targets.length)];
            const dx = target.position.x - x, dy = target.position.y - y, dz = target.position.z - z;
            const dist = Math.hypot(dx, dy, dz) || 1;
            vx = (dx / dist) * speed;
            vy = (dy / dist) * speed;
            vz = (dz / dist) * speed;
            if (vy >= 0) vy = -speed; // never launch a meteor upward
        }
    }

    const t = vy < 0 ? (y - GROUND_Y) / -vy : 0;
    const landingX = x + vx * t;
    const landingZ = z + vz * t;

    const warnTicks = (homing ? HOMING_WARN_SECONDS : NORMAL_WARN_SECONDS) * TICK_HZ;
    const shadowY = GROUND_Y + Math.abs(vy) * warnTicks;

    meteors.push({ id: nextMeteorId++, x, y, z, vx, vy, vz, radius, landingX, landingZ, shadowY, homing });
}

function meteorHitsPlayer(meteor, player) {
    const halfW = PLAYER_SIZE.width / 2, halfH = PLAYER_SIZE.height / 2, halfD = PLAYER_SIZE.depth / 2;
    const closestX = Math.max(player.position.x - halfW, Math.min(meteor.x, player.position.x + halfW));
    const closestY = Math.max(player.position.y - halfH, Math.min(meteor.y, player.position.y + halfH));
    const closestZ = Math.max(player.position.z - halfD, Math.min(meteor.z, player.position.z + halfD));
    const dx = meteor.x - closestX, dy = meteor.y - closestY, dz = meteor.z - closestZ;
    return (dx * dx + dy * dy + dz * dz) < meteor.radius * meteor.radius;
}

function stepMeteors() {
    ticksUntilMeteor--;
    if (ticksUntilMeteor <= 0) {
        spawnMeteor();
        ticksUntilMeteor = nextSpawnTicks();
    }

    for (let i = meteors.length - 1; i >= 0; i--) {
        const meteor = meteors[i];
        meteor.x += meteor.vx;
        meteor.y += meteor.vy;
        meteor.z += meteor.vz;

        let hit = false;
        for (const { player } of players.values()) {
            if (player.admin && player.admin.fly) continue;
            if (meteorHitsPlayer(meteor, player)) {
                respawnPlayer(player);
                hit = true;
            }
        }

        const landed = meteor.y - meteor.radius <= GROUND_Y;
        if (hit || landed) {
            pendingExplosions.push({ x: meteor.x, y: Math.max(meteor.y, GROUND_Y), z: meteor.z, radius: meteor.radius });
        }
        if (hit || landed || meteor.y < METEOR_DESPAWN_Y) meteors.splice(i, 1);
    }
}

// --- Gimmicks, ported from the 2D prototype (jump-to-happiness) ---

const RED_LIGHT_TICKS = 300;
const GREEN_LIGHT_TICKS = 540;
const LAVA_RISE_PER_TICK = 0.004;
const LAVA_START_Y = -10;
const LAVA_RESET_ABOVE = TOWER_HEIGHT + 10;
const PAYWALL_INTERVAL_TICKS = 2400;
const PAYWALL_PAY_CHANCE = 0.5;

const gimmick = {
    redLight: false,
    redLightTimer: 0,
    greenLightTimer: GREEN_LIGHT_TICKS,
    lavaY: LAVA_START_Y,
    paywallTimer: PAYWALL_INTERVAL_TICKS,
};

function isImmune(player) {
    return player.admin && player.admin.fly;
}

function stepRedLight() {
    if (gimmick.redLight) {
        gimmick.redLightTimer--;
        if (gimmick.redLightTimer <= 0) {
            gimmick.redLight = false;
            gimmick.greenLightTimer = GREEN_LIGHT_TICKS;
        }
    } else {
        gimmick.greenLightTimer--;
        if (gimmick.greenLightTimer <= 0) {
            gimmick.redLight = true;
            gimmick.redLightTimer = RED_LIGHT_TICKS;
        }
    }
}

// Getting caught moving during red light sends you back to spawn — classic
// red-light-green-light, checked against the keys the player is holding this tick.
function enforceRedLight() {
    if (!gimmick.redLight) return;
    for (const { player } of players.values()) {
        if (isImmune(player)) continue;
        const k = player.keys;
        if (k.w || k.a || k.s || k.d || k.jump || k.down) respawnPlayer(player);
    }
}

function stepLava() {
    gimmick.lavaY += LAVA_RISE_PER_TICK;
    if (gimmick.lavaY > LAVA_RESET_ABOVE) gimmick.lavaY = LAVA_START_Y;

    for (const { player } of players.values()) {
        if (isImmune(player)) continue;
        if (player.position.y - PLAYER_SIZE.height / 2 < gimmick.lavaY) {
            respawnPlayer(player);
            // A death resets the lava for everyone, instead of pushing just this
            // player up — otherwise a death right after spawn keeps re-triggering.
            gimmick.lavaY = LAVA_START_Y;
        }
    }
}

// Everyone gets the "PAY UP" prompt; each player independently rolls whether they
// "paid" — the unlucky ones get yanked back to spawn.
function stepPaywall() {
    gimmick.paywallTimer--;
    if (gimmick.paywallTimer > 0) return;
    gimmick.paywallTimer = PAYWALL_INTERVAL_TICKS;

    broadcastRaw({ type: 'paywall' });
    for (const { player } of players.values()) {
        if (isImmune(player)) continue;
        if (Math.random() >= PAYWALL_PAY_CHANCE) respawnPlayer(player);
    }
}

function stepGimmicks() {
    stepRedLight();
    enforceRedLight();
    stepLava();
    stepPaywall();
}

// Keyed by IP rather than per-connection, so opening another tab/socket doesn't
// reset the fail counter and sidestep the lockout.
const ipAuthState = new Map();

function getAuthState(ip) {
    let state = ipAuthState.get(ip);
    if (!state) {
        state = { fails: 0, lockUntil: 0 };
        ipAuthState.set(ip, state);
    }
    return state;
}

function timingSafeEqualStrings(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) {
        crypto.timingSafeEqual(bufB, bufB); // keep timing comparable
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
}

function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

function serveStatic(req, res) {
    const urlPath = req.url.split('?')[0];
    const relPath = urlPath === '/' ? '/index.html' : urlPath;
    const filePath = path.join(PUBLIC_DIR, path.normalize(relPath).replace(/^(\.\.[/\\])+/, ''));
    if (!filePath.startsWith(PUBLIC_DIR)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not found');
            return;
        }
        res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream' });
        res.end(data);
    });
}

const httpServer = http.createServer(serveStatic);
const wss = new WebSocketServer({ server: httpServer });

httpServer.listen(PORT, () => {
    console.log(`Serving game + WebSocket on :${PORT}`);
});

wss.on('connection', (ws, req) => {
    const id = freeIds.length ? freeIds.shift() : nextId++;
    const ip = req.socket.remoteAddress;
    const player = createPlayer();
    player.keys = { w: false, a: false, s: false, d: false, jump: false, down: false };
    const entry = { ws, player, lastChatAt: 0 };
    players.set(id, entry);

    ws.send(JSON.stringify({ type: 'welcome', id, level }));

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        const entry = players.get(id);
        if (!entry) return;

        if (msg.type === 'input') {
            const k = msg.keys || {};
            entry.player.keys = {
                w: !!k.w, a: !!k.a, s: !!k.s, d: !!k.d, jump: !!k.jump, down: !!k.down,
            };
            if (typeof msg.angleY === 'number') entry.player.angleY = msg.angleY;
            return;
        }

        if (msg.type === 'chat') {
            const now = Date.now();
            if (now - entry.lastChatAt < CHAT_MIN_INTERVAL_MS) return;
            if (typeof msg.text !== 'string') return;
            const text = msg.text.trim().slice(0, CHAT_MAX_LEN);
            if (!text) return;
            entry.lastChatAt = now;
            broadcastRaw({ type: 'chat', id, text });
            return;
        }

        if (msg.type === 'admin_auth') {
            const now = Date.now();
            const authState = getAuthState(ip);
            if (now < authState.lockUntil) {
                ws.send(JSON.stringify({ type: 'admin_auth_result', ok: false, locked: true }));
                return;
            }
            const ok = typeof msg.code === 'string' && timingSafeEqualStrings(msg.code, ADMIN_CODE);
            if (ok) {
                authState.fails = 0;
                entry.player.admin.authed = true;
            } else {
                authState.fails++;
                if (authState.fails >= AUTH_MAX_FAILS) {
                    authState.lockUntil = now + AUTH_LOCKOUT_MS;
                    authState.fails = 0;
                }
            }
            ws.send(JSON.stringify({ type: 'admin_auth_result', ok }));
            return;
        }

        if (msg.type === 'admin_cmd') {
            if (!entry.player.admin.authed) return;
            const admin = entry.player.admin;
            switch (msg.cmd) {
                case 'fly':
                    admin.fly = !!msg.value;
                    break;
                case 'speed':
                    admin.speedMult = clampNumber(msg.value, 0.1, 10, admin.speedMult);
                    break;
                case 'gravity':
                    admin.gravityMult = clampNumber(msg.value, 0, 5, admin.gravityMult);
                    break;
                case 'jump':
                    admin.jumpMult = clampNumber(msg.value, 0.1, 10, admin.jumpMult);
                    break;
                case 'teleport': {
                    let dest = null;
                    if (msg.target === 'top') dest = { x: SPAWN_POSITION.x, y: TOWER_HEIGHT + 2, z: SPAWN_POSITION.z };
                    else if (msg.target === 'spawn') dest = { x: SPAWN_POSITION.x, y: SPAWN_POSITION.y, z: SPAWN_POSITION.z };
                    if (dest) {
                        entry.player.position = { x: dest.x, y: dest.y, z: dest.z };
                        entry.player.y_vel = 0;
                        entry.player.on_ground = false;
                        entry.player.ridingPlatform = null;
                    }
                    break;
                }
                default:
                    break;
            }
            return;
        }
    });

    ws.on('close', () => {
        players.delete(id);
        freeIds.push(id);
        broadcastRaw({ type: 'leave', id });
    });

    broadcastRaw({ type: 'join', id });
});

function broadcastRaw(msg) {
    const data = JSON.stringify(msg);
    for (const { ws } of players.values()) {
        if (ws.readyState === ws.OPEN) ws.send(data);
    }
}

function broadcastState() {
    const playerState = {};
    for (const [id, { player }] of players.entries()) {
        playerState[id] = { x: player.position.x, y: player.position.y, z: player.position.z, angleY: player.angleY };
    }
    
    
    const platforms = {};
    objects.forEach((object, idx) => {
        if (object.special === 'moving') {
            platforms[idx] = { x: object.position.x, y: object.position.y, z: object.position.z };
        }
    });
    const meteorState = meteors.map((m) => ({
        id: m.id, x: m.x, y: m.y, z: m.z, radius: m.radius,
        landingX: m.landingX, landingZ: m.landingZ, shadowY: m.shadowY, homing: m.homing,
    }));
    const explosionState = pendingExplosions.splice(0, pendingExplosions.length);
    const gimmickState = {
        redLight: gimmick.redLight,
        lavaY: gimmick.lavaY,
    };
    broadcastRaw({
        type: 'state', players: playerState, platforms, meteors: meteorState,
        explosions: explosionState, gimmick: gimmickState,
    });
}

let lastTime = Date.now();
let accumulator = 0;
let tickCount = 0;

setInterval(() => {
    const now = Date.now();
    accumulator += now - lastTime;
    lastTime = now;

    while (accumulator >= TICK_MS) {
        stepGimmicks();

        for (const { player } of players.values()) {
            player.pushDelta.x = 0;
            player.pushDelta.z = 0;
            player.pushBlockedThisTick = false;
        }

        for (const [id, { player }] of players.entries()) {
            const otherPlayers = [];
            for (const [otherId, { player: op }] of players.entries()) {
                if (otherId !== id) otherPlayers.push(op);
            }
            resolveMovement(player, objects, player.keys, otherPlayers);
        }

        const PUSH_CHAIN_ITERATIONS = 6;
        for (let iter = 0; iter < PUSH_CHAIN_ITERATIONS; iter++) {
            const forwarded = new Map();
            for (const [id, { player }] of players.entries()) {
                if (player.pushDelta.x === 0 && player.pushDelta.z === 0) continue;
                const otherPlayers = [];
                for (const [otherId, { player: op }] of players.entries()) {
                    if (otherId !== id) otherPlayers.push(op);
                }
                const attempted = { x: player.pushDelta.x, z: player.pushDelta.z };
                const result = resolvePush(player, attempted, objects, otherPlayers);
                player.pendingDelta.x += result.x;
                player.pendingDelta.z += result.z;

                const blockedX = attempted.x - result.x;
                const blockedZ = attempted.z - result.z;
                if (blockedX !== 0 || blockedZ !== 0) {
                    player.pushBlockedThisTick = true;
                    player.lastPushDirX = attempted.x;
                    player.lastPushDirZ = attempted.z;
                }
                if (result.blockedByX && blockedX !== 0) {
                    const entry = forwarded.get(result.blockedByX) || { x: 0, z: 0 };
                    entry.x += blockedX;
                    forwarded.set(result.blockedByX, entry);
                }
                if (result.blockedByZ && blockedZ !== 0) {
                    const entry = forwarded.get(result.blockedByZ) || { x: 0, z: 0 };
                    entry.z += blockedZ;
                    forwarded.set(result.blockedByZ, entry);
                }

                player.pushDelta.x = 0;
                player.pushDelta.z = 0;
            }
            for (const [targetPlayer, delta] of forwarded.entries()) {
                targetPlayer.pushDelta.x += delta.x;
                targetPlayer.pushDelta.z += delta.z;
            }
        }

        applyDismounts(Array.from(players.values(), (e) => e.player));

        advanceMovingPlatforms(objects);
        for (const { player } of players.values()) {
            applyPendingMove(player, objects);
        }

        stepMeteors();

        tickCount++;
        if (tickCount % BROADCAST_EVERY_N_TICKS === 0) broadcastState();

        accumulator -= TICK_MS;
    }
}, TICK_MS);
