const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { buildObjects, advanceMovingPlatforms, createPlayer, resolveMovement, resolvePush, applyPendingMove } = require('./physics');
const { level } = require('./levels');

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME_TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const TICK_HZ = 60;
const TICK_MS = 1000 / TICK_HZ;
const BROADCAST_EVERY_N_TICKS = 2; 

const objects = buildObjects();
const players = new Map(); 
let nextId = 1;

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
            player.pushDelta.x = 0;
            player.pushDelta.z = 0;
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
            const forwarded = new Map(); // player -> { x, z } to apply next iteration
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

        advanceMovingPlatforms(objects);
        for (const { player } of players.values()) {
            applyPendingMove(player, objects);
        }

        tickCount++;
        if (tickCount % BROADCAST_EVERY_N_TICKS === 0) broadcastState();

        accumulator -= TICK_MS;
    }
}, TICK_MS);
