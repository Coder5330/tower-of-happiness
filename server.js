const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildObjects, advanceMovingPlatforms, createPlayer, resolveMovement, resolvePush, applyPendingMove, applyDismounts, respawnPlayer, hitTestFor } = require('./physics');
const { level, SPAWN_POSITION, TOWER_HEIGHT, GROUND_AREA, PLAYER_SIZE } = require('./levels');
const { recordWin } = require('./db');

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME_TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const TICK_HZ = 60;
const TICK_MS = 1000 / TICK_HZ;
const BROADCAST_EVERY_N_TICKS = 2;

const ADMIN_CODE = process.env.ADMIN_CODE || crypto.randomBytes(6).toString('hex');
if (!process.env.ADMIN_CODE) {
    console.log(`No ADMIN_CODE set — generated admin code for this run: ${ADMIN_CODE}`);
}

const AUTH_MAX_FAILS = 5;
const AUTH_LOCKOUT_MS = 30000;
const CHAT_MAX_LEN = 200;
const CHAT_MIN_INTERVAL_MS = 300;

const METEOR_RADIUS_MIN = 0.4;
const METEOR_RADIUS_MAX = 1.0;
const METEOR_SPEED_MIN = 0.12;
const METEOR_SPEED_MAX = 0.25;
const METEOR_SPAWN_MIN_MS = 1500;
const METEOR_SPAWN_MAX_MS = 3500;
const WARN_SECONDS = 1.6;
const METEOR_SPAWN_Y = TOWER_HEIGHT + 15;
const METEOR_DESPAWN_Y = -5;
const METEOR_XZ_RANGE = GROUND_AREA / 2 - 1.5;
const GROUND_Y = 0;

const LAVA_RISE_PER_TICK = 0.004;
const LAVA_START_Y = -10;
const LAVA_RESET_ABOVE = TOWER_HEIGHT + 10;

const ROUND_DURATION_MS = 5 * 60 * 1000;
const WIN_HEIGHT = TOWER_HEIGHT - 3; // reaching the top platform counts as the win

function randomBetween(min, max) {
    return min + Math.random() * (max - min);
}

function nextSpawnTicks() {
    return Math.max(1, Math.round(randomBetween(METEOR_SPAWN_MIN_MS, METEOR_SPAWN_MAX_MS) / TICK_MS));
}

function isImmune(player) {
    return (player.admin && player.admin.fly) || player.ghost;
}

// --- Rooms ---
// 'main' rooms run the full competitive loop (lava, meteors, a 5-minute round
// clock, a win condition) and sit in a 'waiting' lobby between rounds so anyone
// who joins mid-round never gets dropped into an already-lost game — they just
// spectate as a ghost until the next round starts. 'practice' is a permanent,
// hazard-free sandbox: no lava, no meteors, no round clock.

const rooms = new Map();

function createRoom(id, kind) {
    return {
        id,
        kind,
        objects: buildObjects(),
        players: new Map(),
        nextId: 1,
        freeIds: [],
        meteors: [],
        pendingExplosions: [],
        nextMeteorId: 1,
        ticksUntilMeteor: nextSpawnTicks(),
        gimmick: { lavaY: LAVA_START_Y },
        phase: kind === 'main' ? 'waiting' : 'practice',
        roundEndAt: null,
        tickCount: 0,
    };
}

rooms.set('main', createRoom('main', 'main'));
rooms.set('practice', createRoom('practice', 'practice'));

function roomSummary(room) {
    return { id: room.id, kind: room.kind, phase: room.phase, players: room.players.size };
}

function roomsSnapshot() {
    return Array.from(rooms.values(), roomSummary);
}

function broadcastRoomsSnapshot() {
    const data = JSON.stringify({ type: 'rooms', rooms: roomsSnapshot() });
    for (const conn of connections.values()) {
        if (!conn.room && conn.ws.readyState === conn.ws.OPEN) conn.ws.send(data);
    }
}

function broadcastRaw(room, msg) {
    const data = JSON.stringify(msg);
    for (const { ws } of room.players.values()) {
        if (ws.readyState === ws.OPEN) ws.send(data);
    }
}

function spawnMeteor(room) {
    const radius = randomBetween(METEOR_RADIUS_MIN, METEOR_RADIUS_MAX);
    const speed = randomBetween(METEOR_SPEED_MIN, METEOR_SPEED_MAX);
    const x = randomBetween(-METEOR_XZ_RANGE, METEOR_XZ_RANGE);
    const z = randomBetween(-METEOR_XZ_RANGE, METEOR_XZ_RANGE);
    const y = METEOR_SPAWN_Y;
    const vy = -speed;

    const shadowY = GROUND_Y + speed * WARN_SECONDS * TICK_HZ;

    room.meteors.push({ id: room.nextMeteorId++, x, y, z, vx: 0, vy, vz: 0, radius, landingX: x, landingZ: z, shadowY });
}

function meteorHitsPlayer(meteor, player) {
    const halfW = PLAYER_SIZE.width / 2, halfH = PLAYER_SIZE.height / 2, halfD = PLAYER_SIZE.depth / 2;
    const closestX = Math.max(player.position.x - halfW, Math.min(meteor.x, player.position.x + halfW));
    const closestY = Math.max(player.position.y - halfH, Math.min(meteor.y, player.position.y + halfH));
    const closestZ = Math.max(player.position.z - halfD, Math.min(meteor.z, player.position.z + halfD));
    const dx = meteor.x - closestX, dy = meteor.y - closestY, dz = meteor.z - closestZ;
    return (dx * dx + dy * dy + dz * dz) < meteor.radius * meteor.radius;
}

// Ground is objects[0] and every tower platform is in there too, so this single
// scan covers "meteor lands on the ground" and "meteor gets intercepted by a
// platform" the same way — approximating the meteor as a bounding cube.
function meteorHitsSolid(room, meteor) {
    const size = { width: meteor.radius * 2, height: meteor.radius * 2, depth: meteor.radius * 2 };
    const pos = { x: meteor.x, y: meteor.y, z: meteor.z };
    for (const object of room.objects) {
        if (hitTestFor(object, size)(pos)) return true;
    }
    return false;
}

function stepMeteors(room) {
    room.ticksUntilMeteor--;
    if (room.ticksUntilMeteor <= 0) {
        spawnMeteor(room);
        room.ticksUntilMeteor = nextSpawnTicks();
    }

    for (let i = room.meteors.length - 1; i >= 0; i--) {
        const meteor = room.meteors[i];
        meteor.x += meteor.vx;
        meteor.y += meteor.vy;
        meteor.z += meteor.vz;

        let hit = false;
        for (const { player } of room.players.values()) {
            if (isImmune(player)) continue;
            if (meteorHitsPlayer(meteor, player)) {
                respawnPlayer(player);
                hit = true;
            }
        }

        const intercepted = meteorHitsSolid(room, meteor);
        if (hit || intercepted) {
            room.pendingExplosions.push({ x: meteor.x, y: Math.max(meteor.y, GROUND_Y), z: meteor.z, radius: meteor.radius });
        }
        if (hit || intercepted || meteor.y < METEOR_DESPAWN_Y) room.meteors.splice(i, 1);
    }
}

// The lava never resets on a death — instead, whoever it catches becomes a ghost:
// immune, free-flying (reuses the fly physics), able to watch the others climb.
// Everyone gets revived only once the lava completes a full cycle and loops back down.
function stepLava(room) {
    room.gimmick.lavaY += LAVA_RISE_PER_TICK;
    if (room.gimmick.lavaY > LAVA_RESET_ABOVE) {
        room.gimmick.lavaY = LAVA_START_Y;
        for (const { player } of room.players.values()) {
            if (!player.ghost) continue;
            player.ghost = false;
            respawnPlayer(player);
        }
    }

    for (const { player } of room.players.values()) {
        if (isImmune(player)) continue;
        if (player.position.y - PLAYER_SIZE.height / 2 < room.gimmick.lavaY) {
            player.ghost = true;
        }
    }
}

// Between rounds (and permanently, for practice) the room sits in a lobby: no
// hazards, everyone gets a clean respawn so latecomers and round-losers start level.
function resetToLobby(room) {
    room.phase = room.kind === 'main' ? 'waiting' : 'practice';
    room.gimmick.lavaY = LAVA_START_Y;
    room.meteors.length = 0;
    for (const { player } of room.players.values()) {
        player.ghost = false;
        respawnPlayer(player);
    }
    broadcastRaw(room, { type: 'phase', phase: room.phase });
}

function startRound(room) {
    if (room.kind !== 'main' || room.phase !== 'waiting') return;
    room.phase = 'playing';
    room.roundEndAt = Date.now() + ROUND_DURATION_MS;
    room.gimmick.lavaY = LAVA_START_Y;
    for (const { player } of room.players.values()) {
        player.ghost = false;
        respawnPlayer(player);
    }
    broadcastRaw(room, { type: 'phase', phase: room.phase });
}

function stepRound(room) {
    if (room.kind !== 'main' || room.phase !== 'playing') return;
    const now = Date.now();

    for (const [id, { player }] of room.players.entries()) {
        if (isImmune(player)) continue; // ghosts and flying admins can't win
        if (player.position.y < WIN_HEIGHT) continue;

        const secondsLeft = Math.max(0, (room.roundEndAt - now) / 1000);
        broadcastRaw(room, { type: 'round_result', winner: id, secondsLeft });
        recordWin(secondsLeft);
        resetToLobby(room);
        return;
    }

    if (now >= room.roundEndAt) {
        broadcastRaw(room, { type: 'round_result', winner: null, secondsLeft: 0 });
        resetToLobby(room);
    }
}

function broadcastState(room) {
    const playerState = {};
    for (const [id, { player }] of room.players.entries()) {
        playerState[id] = { x: player.position.x, y: player.position.y, z: player.position.z, angleY: player.angleY, ghost: player.ghost };
    }

    const platforms = {};
    room.objects.forEach((object, idx) => {
        if (object.special === 'moving') {
            platforms[idx] = { x: object.position.x, y: object.position.y, z: object.position.z };
        }
    });
    const meteorState = room.meteors.map((m) => ({
        id: m.id, x: m.x, y: m.y, z: m.z, radius: m.radius,
        landingX: m.landingX, landingZ: m.landingZ, shadowY: m.shadowY,
    }));
    const explosionState = room.pendingExplosions.splice(0, room.pendingExplosions.length);
    const gimmickState = {
        lavaY: room.gimmick.lavaY,
    };
    broadcastRaw(room, {
        type: 'state', players: playerState, platforms, meteors: meteorState,
        explosions: explosionState, gimmick: gimmickState,
        phase: room.phase,
        roundMsLeft: room.roundEndAt ? Math.max(0, room.roundEndAt - Date.now()) : null,
    });
}

function stepRoomTick(room) {
    stepLava(room);

    for (const { player } of room.players.values()) {
        player.pushDelta.x = 0;
        player.pushDelta.z = 0;
        player.pushBlockedThisTick = false;
    }

    for (const [id, { player }] of room.players.entries()) {
        const otherPlayers = [];
        for (const [otherId, { player: op }] of room.players.entries()) {
            if (otherId !== id) otherPlayers.push(op);
        }
        resolveMovement(player, room.objects, player.keys, otherPlayers);
    }

    const PUSH_CHAIN_ITERATIONS = 6;
    for (let iter = 0; iter < PUSH_CHAIN_ITERATIONS; iter++) {
        const forwarded = new Map(); // player -> { x, z } to apply next iteration
        for (const [id, { player }] of room.players.entries()) {
            if (player.pushDelta.x === 0 && player.pushDelta.z === 0) continue;
            const otherPlayers = [];
            for (const [otherId, { player: op }] of room.players.entries()) {
                if (otherId !== id) otherPlayers.push(op);
            }
            const attempted = { x: player.pushDelta.x, z: player.pushDelta.z };
            const result = resolvePush(player, attempted, room.objects, otherPlayers);
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

    applyDismounts(Array.from(room.players.values(), (e) => e.player));

    advanceMovingPlatforms(room.objects);
    for (const { player } of room.players.values()) {
        applyPendingMove(player, room.objects);
    }

    stepMeteors(room);
    stepRound(room);

    room.tickCount++;
    if (room.tickCount % BROADCAST_EVERY_N_TICKS === 0) broadcastState(room);
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

// Sockets that haven't picked a room yet live here, keyed by the ws itself.
const connections = new Map();

wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    const conn = { ws, ip, room: null, playerId: null, lastChatAt: 0 };
    connections.set(ws, conn);

    ws.send(JSON.stringify({ type: 'rooms', rooms: roomsSnapshot() }));

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        const conn = connections.get(ws);
        if (!conn) return;

        if (msg.type === 'join_room') {
            if (conn.room) return;
            const room = rooms.get(msg.room);
            if (!room) return;

            const id = room.freeIds.length ? room.freeIds.shift() : room.nextId++;
            const player = createPlayer();
            player.keys = { w: false, a: false, s: false, d: false, jump: false, down: false };
            if (room.kind === 'main' && room.phase === 'playing') player.ghost = true; // late joiner spectates till next round
            room.players.set(id, { ws, player });
            conn.room = room;
            conn.playerId = id;

            ws.send(JSON.stringify({ type: 'welcome', id, level, roomId: room.id, roomKind: room.kind, phase: room.phase }));
            broadcastRaw(room, { type: 'join', id });
            broadcastRoomsSnapshot();
            return;
        }

        if (msg.type === 'start_round') {
            if (conn.room) startRound(conn.room);
            return;
        }

        if (!conn.room) return;
        const room = conn.room;
        const id = conn.playerId;
        const entry = room.players.get(id);
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
            if (now - conn.lastChatAt < CHAT_MIN_INTERVAL_MS) return;
            if (typeof msg.text !== 'string') return;
            const text = msg.text.trim().slice(0, CHAT_MAX_LEN);
            if (!text) return;
            conn.lastChatAt = now;
            broadcastRaw(room, { type: 'chat', id, text });
            return;
        }

        if (msg.type === 'admin_auth') {
            const now = Date.now();
            const authState = getAuthState(conn.ip);
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
        const conn = connections.get(ws);
        connections.delete(ws);
        if (!conn || !conn.room) return;
        const { room, playerId } = conn;
        room.players.delete(playerId);
        room.freeIds.push(playerId);
        broadcastRaw(room, { type: 'leave', id: playerId });
        broadcastRoomsSnapshot();
    });
});

let lastTime = Date.now();
let accumulator = 0;

setInterval(() => {
    const now = Date.now();
    accumulator += now - lastTime;
    lastTime = now;

    while (accumulator >= TICK_MS) {
        for (const room of rooms.values()) stepRoomTick(room);
        accumulator -= TICK_MS;
    }
}, TICK_MS);
