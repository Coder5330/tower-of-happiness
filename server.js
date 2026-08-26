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

const METEOR_RADIUS = 0.6;
const METEOR_SPEED = 0.5;
const METEOR_SPAWN_EVERY_TICKS = 90;
const METEOR_SPAWN_Y = TOWER_HEIGHT + 15;
const METEOR_DESPAWN_Y = -5;
const METEOR_XZ_RANGE = GROUND_AREA / 2 - 1.5;

const meteors = [];
let nextMeteorId = 1;
let ticksUntilMeteor = METEOR_SPAWN_EVERY_TICKS;

function spawnMeteor() {
    meteors.push({
        id: nextMeteorId++,
        x: (Math.random() * 2 - 1) * METEOR_XZ_RANGE,
        y: METEOR_SPAWN_Y,
        z: (Math.random() * 2 - 1) * METEOR_XZ_RANGE,
    });
}

function meteorHitsPlayer(meteor, player) {
    const halfW = PLAYER_SIZE.width / 2, halfH = PLAYER_SIZE.height / 2, halfD = PLAYER_SIZE.depth / 2;
    const closestX = Math.max(player.position.x - halfW, Math.min(meteor.x, player.position.x + halfW));
    const closestY = Math.max(player.position.y - halfH, Math.min(meteor.y, player.position.y + halfH));
    const closestZ = Math.max(player.position.z - halfD, Math.min(meteor.z, player.position.z + halfD));
    const dx = meteor.x - closestX, dy = meteor.y - closestY, dz = meteor.z - closestZ;
    return (dx * dx + dy * dy + dz * dz) < METEOR_RADIUS * METEOR_RADIUS;
}

function stepMeteors() {
    ticksUntilMeteor--;
    if (ticksUntilMeteor <= 0) {
        spawnMeteor();
        ticksUntilMeteor = METEOR_SPAWN_EVERY_TICKS;
    }

    for (let i = meteors.length - 1; i >= 0; i--) {
        const meteor = meteors[i];
        meteor.y -= METEOR_SPEED;

        let hit = false;
        for (const { player } of players.values()) {
            if (player.admin && player.admin.fly) continue;
            if (meteorHitsPlayer(meteor, player)) {
                respawnPlayer(player);
                hit = true;
            }
        }

        if (hit || meteor.y < METEOR_DESPAWN_Y) meteors.splice(i, 1);
    }
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
    broadcastRaw({ type: 'state', players: playerState, platforms, meteors: meteors.map((m) => ({ id: m.id, x: m.x, y: m.y, z: m.z })) });
}

let lastTime = Date.now();
let accumulator = 0;
let tickCount = 0;

setInterval(() => {
    const now = Date.now();
    accumulator += now - lastTime;
    lastTime = now;

    while (accumulator >= TICK_MS) {
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
