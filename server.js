const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildObjects, advanceMovingPlatforms, createPlayer, resolveMovement, resolvePush, applyPendingMove, applyDismounts, respawnPlayer, hitTestFor } = require('./physics');
const { SPAWN_POSITION, TOWER_HEIGHT, GROUND_AREA, PLAYER_SIZE } = require('./levels');
const { recordWin, getProfile, awardCoins, buyItem } = require('./db');
const { TOWER_POOL, buildTowerLevel, warmTowerPool, randomTowerId, randomTowerChoices } = require('./towers');

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

// --- Shop ---
// Winning a round pays coins; coins buy items that persist with the player
// (see db.js). The punching glove is deliberately limited to competitive
// rooms - practice rooms are for people who just want to climb, and being
// knocked off a platform there would only be griefing.
const SHOP = {
    glove: { price: 5, name: 'Punching glove' },
};
const COINS_PER_WIN = 1;
const COINS_FAST_WIN_BONUS = 1;        // still had a minute on the clock
const FAST_WIN_SECONDS = 60;

const PUNCH_RANGE = 2.4;
const PUNCH_FACING = 0.5;              // dot product: roughly a 60-degree cone
const PUNCH_HEIGHT = 2;
const PUNCH_FORCE = 0.28;              // per tick, before decay
const PUNCH_DECAY = 0.82;
const PUNCH_TICKS = 10;
const PUNCH_LIFT = 0.14;
const PUNCH_COOLDOWN_MS = 700;

const ROUND_DURATION_MS = 5 * 60 * 1000;
const WIN_HEIGHT = TOWER_HEIGHT - 3; // reaching the top platform counts as the win
const TOWER_CHOICE_MS = 15000;
const TOWER_CHOICE_OPTIONS = 3;

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
// 'main'-kind rooms (the fixed Main Game plus any player-created room) run the
// full competitive loop — lava, meteors, a 5-minute round clock, a win
// condition — and sit in a 'waiting' lobby between rounds so anyone who joins
// mid-round never gets dropped into an already-lost game; they spectate as a
// ghost until the next round starts. 'practice' rooms are private, single
// player, permanently hazard-free, and let that one player pick any tower.
// Every room gets its own procedurally generated tower (see towers.js) so no
// two rooms — or two rounds — necessarily look the same.

const MAX_ROOM_PLAYERS = 8;
const CUSTOM_ROOM_NAME_MAX_LEN = 30;

const rooms = new Map();
let nextCustomRoomId = 1;
let nextJoinRequestId = 1;

function createRoom({ id, kind, name, permanent, maxPlayers, towerId, hostWs }) {
    return {
        id,
        kind,
        name,
        permanent,
        maxPlayers,
        hostWs: hostWs || null,
        towerId,
        objects: buildObjects(buildTowerLevel(towerId)),
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
        pendingChoice: null,
        pendingJoins: new Map(),
        tickCount: 0,
    };
}

rooms.set('main', createRoom({
    id: 'main', kind: 'main', name: 'Main Game', permanent: true,
    maxPlayers: Infinity, towerId: randomTowerId(),
}));

// Player-created rooms are competitive ('main' rules) and disappear once the
// last player leaves, so the room list doesn't grow forever. The creator is
// the host: they approve every join and can pick the room's tower.
function createCustomRoom(rawName, hostWs) {
    const id = `room-${nextCustomRoomId++}`;
    const name = (typeof rawName === 'string' ? rawName.trim() : '').slice(0, CUSTOM_ROOM_NAME_MAX_LEN) || `Room ${id.split('-')[1]}`;
    const room = createRoom({
        id, kind: 'main', name, permanent: false,
        maxPlayers: MAX_ROOM_PLAYERS, towerId: randomTowerId(), hostWs,
    });
    rooms.set(id, room);
    return room;
}

// Practice is always a fresh, private room for exactly one player, on
// whichever tower they picked. Never listed in the shared room list.
function createPracticeRoom(towerId) {
    const id = `practice-${nextCustomRoomId++}`;
    const meta = TOWER_POOL.find((t) => t.id === towerId) || TOWER_POOL[0];
    const room = createRoom({
        id, kind: 'practice', name: `Practice (${meta.name})`, permanent: false,
        maxPlayers: 1, towerId: meta.id,
    });
    rooms.set(id, room);
    return room;
}

// 'main'-kind rooms (Main Game and every custom room) never get deleted when
// empty — they just reset, so a room you made sticks around for next time.
// Practice rooms are private and single-player, so an empty one just vanishes.
function handleRoomEmpty(room) {
    if (room.players.size > 0) return;
    if (room.kind === 'main') resetToLobby(room);
    else rooms.delete(room.id);
}

function roomSummary(room) {
    // Infinity isn't valid JSON (it serializes to null) — send null explicitly
    // so the client can render "no cap" instead of misreading it as 0.
    return {
        id: room.id, kind: room.kind, name: room.name, phase: room.phase, players: room.players.size,
        maxPlayers: room.maxPlayers === Infinity ? null : room.maxPlayers,
    };
}

function roomsSnapshot() {
    // Practice rooms are private — never advertised in the shared list.
    return Array.from(rooms.values()).filter((r) => r.kind !== 'practice').map(roomSummary);
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

function towerChoiceList(choices) {
    return choices.map((c) => ({ id: c.id, name: c.name }));
}

function applyTowerChange(room, towerId) {
    room.towerId = towerId;
    room.objects = buildObjects(buildTowerLevel(towerId));
    broadcastRaw(room, { type: 'level', level: buildTowerLevel(towerId) });
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

// Between rounds the room sits in a lobby: no hazards, everyone gets a clean
// respawn so latecomers and round-losers start level.
function resetToLobby(room) {
    room.phase = room.kind === 'main' ? 'waiting' : 'practice';
    room.gimmick.lavaY = LAVA_START_Y;
    room.meteors.length = 0;
    room.roundEndAt = null;
    room.pendingChoice = null;
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

// After a win, the winner gets ~15s to pick the next tower from 3 random
// options; a timeout (or the room emptying) falls back to a random pick.
function beginTowerChoice(room, chooserId) {
    const choices = randomTowerChoices(TOWER_CHOICE_OPTIONS);
    room.phase = 'choosing';
    room.pendingChoice = { chooserId, choices, deadline: Date.now() + TOWER_CHOICE_MS };
    broadcastRaw(room, { type: 'choose_tower', chooserId, choices: towerChoiceList(choices), deadlineMs: TOWER_CHOICE_MS });
}

function resolveTowerChoice(room, towerId) {
    const pending = room.pendingChoice;
    room.pendingChoice = null;
    const valid = pending && pending.choices.some((c) => c.id === towerId);
    const chosenId = valid ? towerId : (pending ? pending.choices[Math.floor(Math.random() * pending.choices.length)].id : randomTowerId());
    applyTowerChange(room, chosenId);
    resetToLobby(room);
}

function stepRound(room) {
    if (room.kind !== 'main') return;

    if (room.phase === 'choosing') {
        if (room.pendingChoice && Date.now() >= room.pendingChoice.deadline) resolveTowerChoice(room, null);
        return;
    }

    if (room.phase !== 'playing') return;
    const now = Date.now();

    for (const [id, { player }] of room.players.entries()) {
        if (isImmune(player)) continue; // ghosts and flying admins can't win
        if (player.position.y < WIN_HEIGHT) continue;

        const secondsLeft = Math.max(0, (room.roundEndAt - now) / 1000);
        broadcastRaw(room, { type: 'round_result', winner: id, secondsLeft });
        recordWin(secondsLeft);
        payOutWin(room, id, secondsLeft);
        beginTowerChoice(room, id);
        return;
    }

    if (now >= room.roundEndAt) {
        broadcastRaw(room, { type: 'round_result', winner: null, secondsLeft: 0 });
        resetToLobby(room);
    }
}

// Winning pays out, and a fast win pays a little more. The profile is pushed
// straight back to that player so the shop and the coin counter update without
// them having to reconnect.
function payOutWin(room, id, secondsLeft) {
    const entry = room.players.get(id);
    if (!entry) return;
    const conn = connections.get(entry.ws);
    if (!conn || !conn.playerKey) return;

    const coins = COINS_PER_WIN + (secondsLeft > FAST_WIN_SECONDS ? COINS_FAST_WIN_BONUS : 0);
    awardCoins(conn.playerKey, coins).then((profile) => {
        conn.profile = profile;
        entry.player.hasGlove = profile.items.includes('glove');
        sendProfile(conn, { earned: coins });
    });
}

function sendProfile(conn, extra) {
    if (!conn.profile || conn.ws.readyState !== conn.ws.OPEN) return;
    conn.ws.send(JSON.stringify(Object.assign({
        type: 'profile',
        coins: conn.profile.coins,
        items: conn.profile.items,
        wins: conn.profile.wins,
        shop: SHOP,
    }, extra || {})));
}

function punch(room, id, player, conn) {
    if (room.kind !== 'main' || room.phase !== 'playing') return;
    if (!conn.profile || !conn.profile.items.includes('glove')) return;
    if (player.ghost) return;

    const now = Date.now();
    if (now - (conn.lastPunchAt || 0) < PUNCH_COOLDOWN_MS) return;
    conn.lastPunchAt = now;

    const forward = { x: -Math.sin(player.angleY), z: -Math.cos(player.angleY) };
    const hits = [];

    for (const [otherId, { player: target }] of room.players.entries()) {
        if (otherId === id || target.ghost) continue;
        const dx = target.position.x - player.position.x;
        const dz = target.position.z - player.position.z;
        if (Math.abs(target.position.y - player.position.y) > PUNCH_HEIGHT) continue;
        const dist = Math.hypot(dx, dz);
        if (dist > PUNCH_RANGE) continue;
        const dirX = dist > 0.001 ? dx / dist : forward.x;
        const dirZ = dist > 0.001 ? dz / dist : forward.z;
        if (dist > 0.001 && dirX * forward.x + dirZ * forward.z < PUNCH_FACING) continue;

        target.knockback = { x: dirX * PUNCH_FORCE, z: dirZ * PUNCH_FORCE, ticks: PUNCH_TICKS };
        target.y_vel = Math.max(target.y_vel, PUNCH_LIFT);
        target.on_ground = false;
        target.ridingPlatform = null;
        hits.push(otherId);
    }

    broadcastRaw(room, { type: 'punch', id, hits });
}

function broadcastState(room) {
    const playerState = {};
    for (const [id, { player }] of room.players.entries()) {
        playerState[id] = {
            x: player.position.x, y: player.position.y, z: player.position.z,
            angleY: player.angleY, ghost: player.ghost, glove: !!player.hasGlove,
        };
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
        roundMsLeft: room.roundEndAt && room.phase === 'playing' ? Math.max(0, room.roundEndAt - Date.now()) : null,
    });
}

function stepRoomTick(room) {
    if (room.kind === 'main' && room.phase === 'playing') stepLava(room);

    for (const { player } of room.players.values()) {
        player.pushDelta.x = 0;
        player.pushDelta.z = 0;
        player.pushBlockedThisTick = false;

        // A punch is just a push that keeps arriving for a few ticks, so it
        // travels through the same collision and dismount handling as players
        // shoving each other.
        const kb = player.knockback;
        if (kb && kb.ticks > 0) {
            player.pushDelta.x += kb.x;
            player.pushDelta.z += kb.z;
            kb.x *= PUNCH_DECAY;
            kb.z *= PUNCH_DECAY;
            kb.ticks--;
        }
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

    if (room.kind === 'main') {
        if (room.phase === 'playing') stepMeteors(room);
        stepRound(room);
    }

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
    // Normally every tower has already been loaded from towers.json and this
    // does nothing. It only has work to do when that file is missing or was
    // built from a different seed, and then it generates the pool a tower at a
    // time *after* the port is open — so a deploy starts answering immediately
    // instead of looking dead while it simulates a few hundred jumps.
    const startedAt = Date.now();
    warmTowerPool((generated) => {
        if (generated) {
            console.log(`Generated ${generated} tower(s) in ${((Date.now() - startedAt) / 1000).toFixed(1)}s ` +
                '— run `npm run towers` to bake them into towers.json and skip this next time');
        }
    });
});

// Sockets that haven't picked a room yet live here, keyed by the ws itself.
const connections = new Map();

function addPlayerToRoom(ws, conn, room) {
    const id = room.freeIds.length ? room.freeIds.shift() : room.nextId++;
    const player = createPlayer();
    player.keys = { w: false, a: false, s: false, d: false, jump: false, down: false };
    player.hasGlove = !!(conn.profile && conn.profile.items.includes('glove'));
    if (room.kind === 'main' && room.phase === 'playing') player.ghost = true; // late joiner spectates till next round
    room.players.set(id, { ws, player });
    conn.room = room;
    conn.playerId = id;

    ws.send(JSON.stringify({
        type: 'welcome', id, level: buildTowerLevel(room.towerId),
        roomId: room.id, roomKind: room.kind, roomName: room.name, phase: room.phase,
        isHost: room.hostWs === ws, towerPool: TOWER_POOL.map((t) => ({ id: t.id, name: t.name })),
    }));
    broadcastRaw(room, { type: 'join', id });
    broadcastRoomsSnapshot();
}

wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    const conn = {
        ws, ip, room: null, playerId: null, lastChatAt: 0, pendingRoom: null,
        pendingRequestId: null, playerKey: null, profile: null, lastPunchAt: 0,
    };
    connections.set(ws, conn);

    ws.send(JSON.stringify({ type: 'rooms', rooms: roomsSnapshot(), towerPool: TOWER_POOL.map((t) => ({ id: t.id, name: t.name })) }));

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        const conn = connections.get(ws);
        if (!conn) return;

        // The browser makes up a key on first visit and keeps it in
        // localStorage; it is what coins and purchases hang off. There are no
        // accounts, so it identifies a browser, not a person.
        if (msg.type === 'hello') {
            if (conn.playerKey) return;
            const key = typeof msg.playerKey === 'string' ? msg.playerKey.slice(0, 64) : '';
            if (!/^[A-Za-z0-9_-]{8,64}$/.test(key)) return;
            conn.playerKey = key;
            getProfile(key).then((profile) => {
                conn.profile = profile;
                if (conn.room && conn.playerId != null) {
                    const entry = conn.room.players.get(conn.playerId);
                    if (entry) entry.player.hasGlove = profile.items.includes('glove');
                }
                sendProfile(conn);
            });
            return;
        }

        if (msg.type === 'buy') {
            const item = typeof msg.item === 'string' ? msg.item : '';
            const listing = SHOP[item];
            if (!listing || !conn.playerKey) return;
            buyItem(conn.playerKey, item, listing.price).then((profile) => {
                if (!profile) {
                    sendProfile(conn, { bought: null, reason: 'declined' });
                    return;
                }
                conn.profile = profile;
                if (conn.room && conn.playerId != null) {
                    const entry = conn.room.players.get(conn.playerId);
                    if (entry) entry.player.hasGlove = profile.items.includes('glove');
                }
                sendProfile(conn, { bought: item });
            });
            return;
        }

        if (msg.type === 'create_room') {
            if (conn.room) return;
            const room = createCustomRoom(msg.name, ws);
            broadcastRoomsSnapshot();
            ws.send(JSON.stringify({ type: 'room_created', roomId: room.id }));
            return;
        }

        if (msg.type === 'start_practice') {
            if (conn.room) return;
            const towerId = Number(msg.towerId);
            const room = createPracticeRoom(TOWER_POOL.some((t) => t.id === towerId) ? towerId : randomTowerId());
            addPlayerToRoom(ws, conn, room);
            return;
        }

        if (msg.type === 'join_room') {
            if (conn.room || conn.pendingRoom) return;
            const room = rooms.get(msg.room);
            if (!room || room.kind === 'practice') return;
            if (room.players.size >= room.maxPlayers) {
                ws.send(JSON.stringify({ type: 'join_error', reason: 'full', roomId: room.id }));
                return;
            }

            // An unhosted custom room (host left) is claimed by whoever joins next.
            if (!room.permanent && !room.hostWs) room.hostWs = ws;

            const needsApproval = !room.permanent && room.hostWs && room.hostWs !== ws;
            if (needsApproval) {
                const requestId = nextJoinRequestId++;
                room.pendingJoins.set(requestId, { ws });
                conn.pendingRoom = room;
                conn.pendingRequestId = requestId;
                if (room.hostWs.readyState === room.hostWs.OPEN) {
                    room.hostWs.send(JSON.stringify({ type: 'join_request', requestId, roomId: room.id }));
                }
                ws.send(JSON.stringify({ type: 'join_pending', roomId: room.id }));
                return;
            }

            addPlayerToRoom(ws, conn, room);
            return;
        }

        if (msg.type === 'approve_join' || msg.type === 'deny_join') {
            const room = conn.room;
            if (!room || room.hostWs !== ws) return;
            const requestId = Number(msg.requestId);
            const pending = room.pendingJoins.get(requestId);
            if (!pending) return;
            room.pendingJoins.delete(requestId);

            const reqConn = connections.get(pending.ws);
            if (reqConn) { reqConn.pendingRoom = null; reqConn.pendingRequestId = null; }

            if (msg.type === 'approve_join' && pending.ws.readyState === pending.ws.OPEN) {
                if (room.players.size >= room.maxPlayers) {
                    pending.ws.send(JSON.stringify({ type: 'join_error', reason: 'full', roomId: room.id }));
                } else if (reqConn) {
                    addPlayerToRoom(pending.ws, reqConn, room);
                }
            } else if (pending.ws.readyState === pending.ws.OPEN) {
                pending.ws.send(JSON.stringify({ type: 'join_error', reason: 'denied', roomId: room.id }));
            }
            return;
        }

        if (msg.type === 'start_round') {
            if (conn.room) startRound(conn.room);
            return;
        }

        if (msg.type === 'choose_next_tower') {
            const room = conn.room;
            if (!room || !room.pendingChoice || room.pendingChoice.chooserId !== conn.playerId) return;
            resolveTowerChoice(room, Number(msg.towerId));
            return;
        }

        if (msg.type === 'set_room_tower') {
            const room = conn.room;
            if (!room || room.permanent || room.hostWs !== ws || room.phase !== 'waiting') return;
            const towerId = Number(msg.towerId);
            if (!TOWER_POOL.some((t) => t.id === towerId)) return;
            applyTowerChange(room, towerId);
            for (const { player } of room.players.values()) respawnPlayer(player);
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

        if (msg.type === 'punch') {
            punch(room, id, entry.player, conn);
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
        if (!conn) return;

        if (conn.pendingRoom) {
            conn.pendingRoom.pendingJoins.delete(conn.pendingRequestId);
        }

        if (!conn.room) return;
        const { room, playerId } = conn;
        room.players.delete(playerId);
        room.freeIds.push(playerId);
        broadcastRaw(room, { type: 'leave', id: playerId });
        if (room.hostWs === ws) {
            // Host disconnected — deny anyone still waiting on approval rather
            // than leaving them stuck forever, and clear the host slot so the
            // room doesn't become permanently unjoinable (custom rooms persist
            // when empty now, instead of being deleted). The next player to
            // join an unhosted room automatically becomes its new host.
            for (const pending of room.pendingJoins.values()) {
                if (pending.ws.readyState === pending.ws.OPEN) {
                    pending.ws.send(JSON.stringify({ type: 'join_error', reason: 'host_left', roomId: room.id }));
                }
                const pendingConn = connections.get(pending.ws);
                if (pendingConn) { pendingConn.pendingRoom = null; pendingConn.pendingRequestId = null; }
            }
            room.pendingJoins.clear();
            room.hostWs = null;
        }
        handleRoomEmpty(room);
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
