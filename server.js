const { WebSocketServer } = require('ws');
const { buildObjects, advanceMovingPlatforms, createPlayer, resolveMovement, applyPendingMove } = require('./physics');
const { level } = require('./levelData');

const PORT = process.env.PORT || 8080;
const TICK_HZ = 60;
const TICK_MS = 1000 / TICK_HZ;
const BROADCAST_EVERY_N_TICKS = 2;

const objects = buildObjects();
const players = new Map();
let nextId = 1;

const wss = new WebSocketServer({ port: PORT });
console.log(`Game server listening on :${PORT}`);

wss.on('connection', (ws) => {
    const id = nextId++;
    const player = createPlayer();
    player.keys = { w: false, a: false, s: false, d: false, jump: false };
    players.set(id, { ws, player });

    ws.send(JSON.stringify({ type: 'welcome', id, level }));

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        if (msg.type !== 'input') return;

        const entry = players.get(id);
        if (!entry) return;
        const k = msg.keys || {};
        entry.player.keys = {
            w: !!k.w, a: !!k.a, s: !!k.s, d: !!k.d, jump: !!k.jump,
        };
        if (typeof msg.angleY === 'number') entry.player.angleY = msg.angleY;
    });

    ws.on('close', () => {
        players.delete(id);
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
    broadcastRaw({ type: 'state', players: playerState, platforms });
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
            resolveMovement(player, objects, player.keys);
        }
        advanceMovingPlatforms(objects);
        for (const { player } of players.values()) {
            applyPendingMove(player, objects);
        }

        tickCount++;
        if (tickCount % BROADCAST_EVERY_N_TICKS === 0) broadcastState();

        accumulator -= TICK_MS;
    }
}, TICK_MS);
