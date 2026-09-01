const MOUSE_SENSITIVITY = 0.002;
const TOWER_HEIGHT = 60;       
const GROUND_AREA = 40;        
const SPAWN_POSITION = { x: -5, y: 5, z: 0 }; 
const SERVER_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);
scene.fog = new THREE.Fog(0x87ceeb, 20, 150);

const raycaster = new THREE.Raycaster();

const hudCanvas = document.getElementById('hudCanvas');
const hudCtx = hudCanvas.getContext('2d');

function resizeHud() {
    hudCanvas.width = window.innerWidth;
    hudCanvas.height = window.innerHeight;
}
window.addEventListener('resize', resizeHud);
resizeHud();

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 0.4, 0);
camera.rotation.order = 'YXZ';

const renderer = new THREE.WebGLRenderer({
    canvas: document.querySelector('#canvas'),
    antialias: true
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);

const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambientLight);

const directionalLight = new THREE.DirectionalLight(0xffffff, 1.2);
directionalLight.position.set(5, 10, 7);
scene.add(directionalLight);

const ground = new THREE.Mesh(
    new THREE.BoxGeometry(GROUND_AREA, 1, GROUND_AREA),
    new THREE.MeshStandardMaterial({ color: 0x228b22 })
);
ground.position.set(0, -0.5, 0);
scene.add(ground);

const collidableMeshes = [ground];

const lava = new THREE.Mesh(
    new THREE.BoxGeometry(GROUND_AREA, 200, GROUND_AREA),
    // DoubleSide so the inside faces render too — otherwise being inside the lava
    // (as a ghost, or briefly on death) shows nothing at all, just empty space.
    new THREE.MeshStandardMaterial({
        color: 0xff3300, emissive: 0xcc2200, emissiveIntensity: 0.9,
        transparent: true, opacity: 0.85, side: THREE.DoubleSide,
    })
);
lava.position.set(0, -110, 0);
scene.add(lava);

let currentLavaY = -10;

function updateLava(lavaY) {
    // The lava box's top face tracks lavaY; its bulk extends far below so it always fills upward.
    currentLavaY = lavaY;
    lava.position.y = lavaY - 100;
}

let platformMeshesByLevelIndex = [];

function clearPlatforms() {
    for (const mesh of platformMeshesByLevelIndex) {
        scene.remove(mesh);
        mesh.geometry.dispose();
        mesh.material.dispose();
    }
    platformMeshesByLevelIndex = [];
    collidableMeshes.length = 1; // keep just [ground]
}

function loadLevel(levelData) {
    if (window.Autoplay) Autoplay.setLevel(levelData);
    clearPlatforms();
    levelData.forEach((p) => {
        platformMeshesByLevelIndex.push(addPlatform(p));
    });
}

function addPlatform(p) {
    let geometry;
    let mesh;

    if (p.shape === "sphere") {
        geometry = new THREE.SphereGeometry(p.radius, 16, 16);
        mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: p.color }));

    } else if (p.shape === "cylinder") {
        geometry = new THREE.CylinderGeometry(p.radius, p.radius, p.length, 12);
        mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: p.color }));
        if (p.axis === 'x') mesh.rotation.z = Math.PI / 2;
        else mesh.rotation.x = Math.PI / 2;

    } else if (p.shape === "triangle") {
        const h = p.size * Math.sqrt(3) / 2;
        const shape = new THREE.Shape();
        shape.moveTo(0, -(2 / 3) * h);
        shape.lineTo(-p.size / 2, (1 / 3) * h);
        shape.lineTo(p.size / 2, (1 / 3) * h);
        shape.lineTo(0, -(2 / 3) * h);
        geometry = new THREE.ExtrudeGeometry(shape, { depth: p.height, bevelEnabled: false });
        mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: p.color }));
        mesh.rotation.x = -Math.PI / 2;

    } else {
        geometry = new THREE.BoxGeometry(p.width, p.height, p.depth);
        mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: p.color }));
    }

    mesh.position.set(p.x, p.y, p.z);
    scene.add(mesh);
    collidableMeshes.push(mesh);
    return mesh;
}

function randint(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
}

function makeCloud(x, y, z) {
    const cloud = new THREE.Group();
    const cloudMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff });
    const puffCount = randint(5, 8);
    for (let i = 0; i < puffCount; i++) {
        const radius = 3 + Math.random() * 3;
        const puff = new THREE.Mesh(new THREE.SphereGeometry(radius, 8, 8), cloudMaterial);
        puff.position.set((Math.random() - 0.5) * 12, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 6);
        cloud.add(puff);
    }
    cloud.position.set(x, y, z);
    scene.add(cloud);
    return cloud;
}

const sun = new THREE.Mesh(new THREE.SphereGeometry(20, 16, 16), new THREE.MeshBasicMaterial({ color: 0xfff5cc }));
const lightDir = new THREE.Vector3(5, 10, 7).normalize();
sun.position.copy(lightDir).multiplyScalar(400);
scene.add(sun);

for (let i = 0; i < randint(5, 30); i++) {
    makeCloud(randint(-150, 150), randint(50, 150), randint(-150, 150));
}

function drawHeightHUD(height) {
    hudCtx.clearRect(0, 0, hudCanvas.width, hudCanvas.height);

    const barWidth = 25;
    const barHeight = hudCanvas.height * 0.6;
    const barX = 30;
    const barY = (hudCanvas.height - barHeight) / 2;

    const gradient = hudCtx.createLinearGradient(0, barY, 0, barY + barHeight);
    gradient.addColorStop(0, 'hsl(280, 100%, 50%)');
    gradient.addColorStop(0.2, 'hsl(240, 100%, 50%)');
    gradient.addColorStop(0.4, 'hsl(180, 100%, 50%)');
    gradient.addColorStop(0.6, 'hsl(120, 100%, 50%)');
    gradient.addColorStop(0.8, 'hsl(60, 100%, 50%)');
    gradient.addColorStop(1, 'hsl(0, 100%, 50%)');

    hudCtx.fillStyle = gradient;
    hudCtx.fillRect(barX, barY, barWidth, barHeight);

    hudCtx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
    hudCtx.lineWidth = 2;
    hudCtx.strokeRect(barX, barY, barWidth, barHeight);

    const currentHeight = Math.max(0, Math.min(height, TOWER_HEIGHT));
    const progressRatio = currentHeight / TOWER_HEIGHT;
    const indicatorY = (barY + barHeight) - (progressRatio * barHeight);

    hudCtx.fillStyle = '#ff0000';
    hudCtx.fillRect(barX - 2, indicatorY, barWidth + 4, 2);

    hudCtx.fillStyle = '#ffffff';
    hudCtx.font = 'bold 14px sans-serif';
    hudCtx.shadowColor = 'rgba(0, 0, 0, 0.8)';
    hudCtx.shadowBlur = 4;
    hudCtx.fillText(`${Math.floor(height)}m`, barX + barWidth + 12, indicatorY + 5);
    hudCtx.shadowBlur = 0;

    drawKitHUD(barX, barY + barHeight + 24);
}

// Rocket fuel and peels left, under the height bar. Both are per round, so
// they only mean anything while one is running.
function drawKitHUD(x, y) {
    if (currentPhase !== 'playing') return;

    let line = y;
    if (myProfile.items.includes('rockets')) {
        const w = 90, h = 8;
        hudCtx.fillStyle = 'rgba(0, 0, 0, 0.45)';
        hudCtx.fillRect(x - 2, line - 2, w + 4, h + 4);
        hudCtx.fillStyle = myKit.fuel > 0.25 ? '#ff9f1a' : '#e74c3c';
        hudCtx.fillRect(x, line, w * Math.max(0, Math.min(1, myKit.fuel)), h);
        hudCtx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
        hudCtx.lineWidth = 1;
        hudCtx.strokeRect(x, line, w, h);
        hudCtx.fillStyle = '#fff';
        hudCtx.font = 'bold 11px sans-serif';
        hudCtx.fillText('FLY (R)', x + w + 8, line + h);
        line += h + 16;
    }

    if (myProfile.items.includes('banana')) {
        hudCtx.fillStyle = myKit.bananas ? '#f1c40f' : 'rgba(255, 255, 255, 0.4)';
        hudCtx.font = 'bold 13px sans-serif';
        hudCtx.shadowColor = 'rgba(0, 0, 0, 0.8)';
        hudCtx.shadowBlur = 4;
        hudCtx.fillText(`${myKit.bananas} peel${myKit.bananas === 1 ? '' : 's'}  (Q)`, x, line + 10);
        hudCtx.shadowBlur = 0;
    }
}

let myId = null;
let mode = 1; 

let angleY = 0;
let angleX = 0;

const remotePlayers = new Map();
const ghostHintEl = document.getElementById('ghostHint');
const lavaOverlayEl = document.getElementById('lavaOverlay');
const roundTimerEl = document.getElementById('roundTimer');
const roundBannerEl = document.getElementById('roundBanner');
const roomMenuEl = document.getElementById('roomMenu');
const roomListEl = document.getElementById('roomList');
const lobbyPanelEl = document.getElementById('lobbyPanel');
const lobbyPlayerListEl = document.getElementById('lobbyPlayerList');
const startRoundBtnEl = document.getElementById('startRoundBtn');
const createRoomInputEl = document.getElementById('createRoomInput');
const createRoomBtnEl = document.getElementById('createRoomBtn');
const practiceToggleBtnEl = document.getElementById('practiceToggleBtn');
const practicePickerEl = document.getElementById('practicePicker');
const joinPendingNoteEl = document.getElementById('joinPendingNote');
const hostTowerRowEl = document.getElementById('hostTowerRow');
const hostTowerSelectEl = document.getElementById('hostTowerSelect');
const joinRequestsPanelEl = document.getElementById('joinRequestsPanel');
const towerChoiceModalEl = document.getElementById('towerChoiceModal');
const towerChoiceOptionsEl = document.getElementById('towerChoiceOptions');
const towerChoiceWaitingNoteEl = document.getElementById('towerChoiceWaitingNote');

// No accounts here: coins hang off a key the browser makes up on first visit
// and keeps. Clearing site data starts you over.
function playerKey() {
    let key = null;
    try { key = localStorage.getItem('towerPlayerKey'); } catch (e) { key = null; }
    if (!key || !/^[A-Za-z0-9_-]{8,64}$/.test(key)) {
        key = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2))
            .replace(/[^A-Za-z0-9_-]/g, '');
        try { localStorage.setItem('towerPlayerKey', key); } catch (e) { /* private mode */ }
    }
    return key;
}

let myProfile = { coins: 0, items: [], wins: 0 };
let myKit = { fuel: 0, bananas: 0 };
let shopListings = {};

let myRoomKind = null;
let currentPhase = null;
let myIsHost = false;
let towerPool = [];

function renderRoomList(rooms) {
    roomListEl.innerHTML = '';
    for (const room of rooms) {
        const full = room.maxPlayers != null && room.players >= room.maxPlayers;
        const el = document.createElement('div');
        el.className = 'roomOption';
        if (full) el.classList.add('roomOptionFull');

        const nameEl = document.createElement('span');
        nameEl.className = 'roomOptionName';
        nameEl.textContent = room.name || (room.kind === 'practice' ? 'Practice' : 'Main Game');

        const metaEl = document.createElement('span');
        metaEl.className = 'roomOptionMeta';
        const status = room.kind === 'practice'
            ? 'no hazards, just climb'
            : (room.phase === 'waiting' ? 'waiting to start' : 'round in progress');
        const countText = room.maxPlayers != null ? `${room.players}/${room.maxPlayers}` : `${room.players}`;
        metaEl.textContent = `${countText} — ${full ? 'full' : status}`;

        el.appendChild(nameEl);
        el.appendChild(metaEl);

        if (!full) {
            el.addEventListener('click', () => {
                if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'join_room', room: room.id }));
            });
        }
        roomListEl.appendChild(el);
    }
}

const shopToggleBtnEl = document.getElementById('shopToggleBtn');
const shopPanelEl = document.getElementById('shopPanel');
const shopCoinsInlineEl = document.getElementById('shopCoinsInline');
const coinCounterEl = document.getElementById('coinCounter');
const coinCountEl = document.getElementById('coinCount');

const ITEM_NOTES = {
    hat: 'A party hat. Does nothing whatsoever.',
    banana: 'Three peels a round, dropped with Q. Catches anyone who walks over one — including you.',
    glove: 'Punch other climbers off the tower. Click to swing.',
    rockets: 'Hold R to fly — full control, no gravity — while fuel lasts. About 6 seconds a round.',
};

function renderShop() {
    shopCoinsInlineEl.textContent = myProfile.coins;
    coinCountEl.textContent = myProfile.coins;
    coinCounterEl.classList.toggle('hidden', myProfile.coins === 0 && !myProfile.items.length);

    shopPanelEl.innerHTML = '';
    for (const [id, listing] of Object.entries(shopListings)) {
        const owned = myProfile.items.includes(id);
        const row = document.createElement('div');
        row.className = 'shopItem';

        const label = document.createElement('div');
        label.className = 'shopItemName';
        label.textContent = listing.name;
        const note = document.createElement('span');
        note.className = 'shopItemNote';
        note.textContent = ITEM_NOTES[id] || '';
        label.appendChild(note);
        row.appendChild(label);

        if (owned) {
            const owned0wn = document.createElement('span');
            owned0wn.className = 'shopItemOwned';
            owned0wn.textContent = 'Owned';
            row.appendChild(owned0wn);
        } else {
            const buy = document.createElement('button');
            buy.textContent = `${listing.price} coins`;
            buy.disabled = myProfile.coins < listing.price;
            buy.addEventListener('click', () => {
                if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'buy', item: id }));
            });
            row.appendChild(buy);
        }
        shopPanelEl.appendChild(row);
    }

    if (!Object.keys(shopListings).length) {
        shopPanelEl.textContent = 'Nothing for sale yet.';
    }
}

shopToggleBtnEl.addEventListener('click', () => {
    shopPanelEl.classList.toggle('hidden');
});

function updateLobbyVisibility(playersObj) {
    const showLobby = myRoomKind === 'main' && currentPhase === 'waiting';
    lobbyPanelEl.classList.toggle('hidden', !showLobby);
    if (showLobby && playersObj) {
        const ids = Object.keys(playersObj);
        lobbyPlayerListEl.textContent = ids.length
            ? ids.map((id) => (Number(id) === myId ? `You (Player ${id})` : `Player ${id}`)).join(', ')
            : 'Just you so far';
    }
}

startRoundBtnEl.addEventListener('click', () => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'start_round' }));
});

function sendCreateRoom() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'create_room', name: createRoomInputEl.value }));
    createRoomInputEl.value = '';
}
createRoomBtnEl.addEventListener('click', sendCreateRoom);
createRoomInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendCreateRoom();
});

function renderPracticePicker() {
    practicePickerEl.innerHTML = '';
    for (const tower of towerPool) {
        const btn = document.createElement('button');
        btn.className = 'towerOption';
        btn.textContent = tower.name;
        btn.addEventListener('click', () => {
            if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'start_practice', towerId: tower.id }));
        });
        practicePickerEl.appendChild(btn);
    }
}

practiceToggleBtnEl.addEventListener('click', () => {
    if (practicePickerEl.classList.contains('hidden') && !practicePickerEl.children.length) renderPracticePicker();
    practicePickerEl.classList.toggle('hidden');
});

function renderHostTowerSelect() {
    hostTowerSelectEl.innerHTML = '';
    for (const tower of towerPool) {
        const opt = document.createElement('option');
        opt.value = tower.id;
        opt.textContent = tower.name;
        hostTowerSelectEl.appendChild(opt);
    }
}

hostTowerSelectEl.addEventListener('change', () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'set_room_tower', towerId: Number(hostTowerSelectEl.value) }));
    }
});

const pendingJoinRequestEls = new Map();

function addJoinRequest(requestId) {
    const row = document.createElement('div');
    row.className = 'joinRequestRow';
    const label = document.createElement('span');
    label.textContent = 'Someone wants to join';
    const approveBtn = document.createElement('button');
    approveBtn.className = 'approveBtn';
    approveBtn.textContent = 'Approve';
    approveBtn.addEventListener('click', () => {
        ws.send(JSON.stringify({ type: 'approve_join', requestId }));
        removeJoinRequest(requestId);
    });
    const denyBtn = document.createElement('button');
    denyBtn.className = 'denyBtn';
    denyBtn.textContent = 'Deny';
    denyBtn.addEventListener('click', () => {
        ws.send(JSON.stringify({ type: 'deny_join', requestId }));
        removeJoinRequest(requestId);
    });
    row.appendChild(label);
    row.appendChild(approveBtn);
    row.appendChild(denyBtn);
    joinRequestsPanelEl.appendChild(row);
    joinRequestsPanelEl.classList.remove('hidden');
    pendingJoinRequestEls.set(requestId, row);
}

function removeJoinRequest(requestId) {
    const row = pendingJoinRequestEls.get(requestId);
    if (row) row.remove();
    pendingJoinRequestEls.delete(requestId);
    if (!pendingJoinRequestEls.size) joinRequestsPanelEl.classList.add('hidden');
}

// Everyone who reached the top votes on the next tower, and finishing sooner
// carries more weight: three votes for first, two for second, one for the rest.
let voteChoices = [];
let voteTally = {};
let myVoteWeight = 0;

function renderVote() {
    towerChoiceOptionsEl.innerHTML = '';
    for (const choice of voteChoices) {
        const btn = document.createElement('button');
        const votes = voteTally[choice.id] || 0;
        btn.textContent = votes ? `${choice.name} — ${votes}` : choice.name;
        btn.disabled = !myVoteWeight;
        if (myVoteWeight) {
            btn.addEventListener('click', () => {
                ws.send(JSON.stringify({ type: 'vote_tower', towerId: choice.id }));
                towerChoiceWaitingNoteEl.textContent = 'Vote cast — waiting for the others…';
                towerChoiceWaitingNoteEl.classList.remove('hidden');
            });
        }
        towerChoiceOptionsEl.appendChild(btn);
    }
}

function showTowerVote(msg) {
    voteChoices = msg.choices;
    voteTally = {};
    myVoteWeight = (msg.weights && msg.weights[myId]) || 0;

    renderVote();
    towerChoiceModalEl.classList.remove('hidden');

    const voters = Object.keys(msg.weights || {}).length;
    if (myVoteWeight) {
        towerChoiceWaitingNoteEl.textContent =
            `Vote for the next tower — your vote counts ${myVoteWeight}×`;
    } else if (voters) {
        towerChoiceWaitingNoteEl.textContent =
            `${voters} climber${voters === 1 ? '' : 's'} reached the top and ${voters === 1 ? 'is' : 'are'} voting…`;
    } else {
        towerChoiceWaitingNoteEl.textContent = 'Nobody reached the top — next tower is random';
    }
    towerChoiceWaitingNoteEl.classList.remove('hidden');
}

function hideTowerChoice() {
    towerChoiceModalEl.classList.add('hidden');
    towerChoiceWaitingNoteEl.classList.add('hidden');
}

function formatRoundTime(msLeft) {
    const totalSeconds = Math.max(0, Math.ceil(msLeft / 1000));
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
}

let roundBannerTimeoutId = null;

function showRoundBanner(text) {
    roundBannerEl.textContent = text;
    roundBannerEl.classList.remove('hidden');
    if (roundBannerTimeoutId) clearTimeout(roundBannerTimeoutId);
    roundBannerTimeoutId = setTimeout(() => {
        roundBannerEl.classList.add('hidden');
        roundBannerTimeoutId = null;
    }, 3500);
}

function colorForPlayer(id) {
    return id === myId ? 0xff4500 : 0x3498db;
}

function ensurePlayerMesh(id) {
    if (remotePlayers.has(id)) return remotePlayers.get(id);
    const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(1, 2, 1),
        new THREE.MeshStandardMaterial({ color: colorForPlayer(id) })
    );
    mesh.visible = !(id === myId && mode === 1); 
    mesh.position.set(SPAWN_POSITION.x, SPAWN_POSITION.y, SPAWN_POSITION.z);
    scene.add(mesh);
    const entry = { mesh, target: { ...SPAWN_POSITION }, glove: null, hat: null, flame: null, swingUntil: 0 };
    remotePlayers.set(id, entry);
    return entry;
}

const gloveGeometry = new THREE.BoxGeometry(0.42, 0.42, 0.42);
const gloveMaterial = new THREE.MeshStandardMaterial({ color: 0xd63031 });
const hatGeometry = new THREE.ConeGeometry(0.32, 0.55, 12);
const hatMaterial = new THREE.MeshStandardMaterial({ color: 0xe84393 });
const flameGeometry = new THREE.ConeGeometry(0.24, 0.7, 10);
const flameMaterial = new THREE.MeshBasicMaterial({ color: 0xff9f1a, transparent: true, opacity: 0.9 });

function setHat(entry, worn) {
    if (worn && !entry.hat) {
        entry.hat = new THREE.Mesh(hatGeometry, hatMaterial);
        entry.hat.position.set(0, 1.28, 0);
        entry.mesh.add(entry.hat);
    } else if (!worn && entry.hat) {
        entry.mesh.remove(entry.hat);
        entry.hat = null;
    }
}

// Boosters only show while they're firing.
function setFlame(entry, lit) {
    if (lit && !entry.flame) {
        entry.flame = new THREE.Mesh(flameGeometry, flameMaterial);
        entry.flame.rotation.x = Math.PI;               // pointing down
        entry.flame.position.set(0, -1.25, 0);
        entry.mesh.add(entry.flame);
    } else if (!lit && entry.flame) {
        entry.mesh.remove(entry.flame);
        entry.flame = null;
    }
    if (entry.flame) {
        const flicker = 0.8 + Math.random() * 0.5;
        entry.flame.scale.set(1, flicker, 1);
    }
}

// Everyone can see who is armed: a red glove on the player's front.
function setGlove(entry, armed) {
    if (armed && !entry.glove) {
        entry.glove = new THREE.Mesh(gloveGeometry, gloveMaterial);
        entry.glove.position.set(0.42, 0.25, -0.5);
        entry.mesh.add(entry.glove);
    } else if (!armed && entry.glove) {
        entry.mesh.remove(entry.glove);
        entry.glove = null;
    }
}

// The first-person glove is parented to the camera so it stays in view.
const ownGlove = new THREE.Mesh(gloveGeometry, gloveMaterial);
ownGlove.visible = false;
camera.add(ownGlove);
scene.add(camera);

const SWING_MS = 220;

// 0 at rest, peaks mid-swing: the glove goes out and comes back.
function swingThrust(until, now) {
    const t = Math.max(0, (until - now) / SWING_MS);
    return Math.sin(t * Math.PI);
}

function updateOwnGlove(now) {
    const armed = myProfile.items.includes('glove') && mode === 1;
    ownGlove.visible = armed;
    if (!armed) return;
    const thrust = swingThrust(swingUntil, now);
    ownGlove.position.set(0.34 - thrust * 0.08, -0.3 + thrust * 0.12, -0.55 - thrust * 0.45);
    ownGlove.rotation.set(thrust * 0.5, 0, 0);
}

// The same swing on the player model, which is what everyone else sees — and
// what you see of yourself in third person.
function updateWorldGlove(entry, now) {
    if (!entry.glove) return;
    const thrust = swingThrust(entry.swingUntil || 0, now);
    entry.glove.position.set(0.42 - thrust * 0.12, 0.25 + thrust * 0.1, -0.5 - thrust * 0.5);
    entry.glove.rotation.x = -thrust * 0.7;
}

function removePlayerMesh(id) {
    const entry = remotePlayers.get(id);
    if (!entry) return;
    scene.remove(entry.mesh);
    remotePlayers.delete(id);
}

// --- Banana peels ---

const bananaMeshes = new Map();
const bananaGeometry = new THREE.CylinderGeometry(0.34, 0.34, 0.08, 10);
const bananaMaterial = new THREE.MeshStandardMaterial({ color: 0xf1c40f });

function syncBananas(list) {
    const seen = new Set();
    for (const peel of list) {
        seen.add(peel.id);
        let mesh = bananaMeshes.get(peel.id);
        if (!mesh) {
            mesh = new THREE.Mesh(bananaGeometry, bananaMaterial);
            mesh.rotation.z = 0.12;                     // sits at a jaunty angle
            scene.add(mesh);
            bananaMeshes.set(peel.id, mesh);
        }
        mesh.position.set(peel.x, peel.y + 0.06, peel.z);
    }
    for (const [id, mesh] of bananaMeshes.entries()) {
        if (seen.has(id)) continue;
        scene.remove(mesh);
        bananaMeshes.delete(id);
    }
}

// A little puff where someone went over
const slipPuffs = [];

function spawnSlip(at) {
    const puff = new THREE.Mesh(
        new THREE.RingGeometry(0.2, 0.5, 16),
        new THREE.MeshBasicMaterial({ color: 0xf1c40f, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
    );
    puff.rotation.x = -Math.PI / 2;
    puff.position.set(at.x, at.y + 0.1, at.z);
    scene.add(puff);
    slipPuffs.push({ mesh: puff, start: performance.now() });
}

function updateSlipPuffs(now) {
    for (let i = slipPuffs.length - 1; i >= 0; i--) {
        const t = (now - slipPuffs[i].start) / 500;
        if (t >= 1) {
            scene.remove(slipPuffs[i].mesh);
            slipPuffs[i].mesh.material.dispose();
            slipPuffs.splice(i, 1);
            continue;
        }
        slipPuffs[i].mesh.scale.setScalar(1 + t * 2);
        slipPuffs[i].mesh.material.opacity = 0.85 * (1 - t);
    }
}

const meteorMeshes = new Map();
const meteorGeometry = new THREE.SphereGeometry(1, 12, 12);
const meteorMaterial = new THREE.MeshStandardMaterial({ color: 0xff3300, emissive: 0x992200, emissiveIntensity: 0.9 });

const shadowGeometry = new THREE.CircleGeometry(1, 24);
const shadowMaterial = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, depthWrite: false });

function ensureMeteorMesh(id, m) {
    if (meteorMeshes.has(id)) return meteorMeshes.get(id);

    const mesh = new THREE.Mesh(meteorGeometry, meteorMaterial);
    mesh.scale.setScalar(m.radius);
    mesh.position.set(m.x, m.y, m.z);
    scene.add(mesh);

    const shadow = new THREE.Mesh(shadowGeometry, shadowMaterial.clone());
    shadow.scale.setScalar(m.radius * 1.4);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.set(m.landingX, 0.03, m.landingZ);
    scene.add(shadow);

    const entry = { mesh, shadow, shadowY: m.shadowY, target: { x: m.x, y: m.y, z: m.z } };
    meteorMeshes.set(id, entry);
    return entry;
}

function syncMeteors(meteorList) {
    const seen = new Set();
    for (const m of meteorList) {
        seen.add(m.id);
        const entry = ensureMeteorMesh(m.id, m);
        entry.target.x = m.x;
        entry.target.y = m.y;
        entry.target.z = m.z;

        const warnRatio = Math.min(1, Math.max(0, 1 - (m.y - 0) / (entry.shadowY - 0)));
        entry.shadow.material.opacity = warnRatio * 0.6;
    }
    for (const [id, entry] of meteorMeshes.entries()) {
        if (!seen.has(id)) {
            scene.remove(entry.mesh);
            scene.remove(entry.shadow);
            entry.shadow.material.dispose();
            meteorMeshes.delete(id);
        }
    }
}

const activeExplosions = [];

function spawnExplosion(pos, radius) {
    const duration = 450;
    const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(1, 12, 12),
        new THREE.MeshBasicMaterial({ color: 0xffaa33, transparent: true, opacity: 0.9 })
    );
    sphere.position.set(pos.x, pos.y, pos.z);
    scene.add(sphere);

    const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.6, 1, 24),
        new THREE.MeshBasicMaterial({ color: 0xff6600, transparent: true, opacity: 0.8, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(pos.x, 0.05, pos.z);
    scene.add(ring);

    activeExplosions.push({ sphere, ring, start: performance.now(), duration, baseRadius: Math.max(0.5, radius) });
}

function processExplosions(explosionList) {
    for (const ex of explosionList) spawnExplosion(ex, ex.radius);
}

function updateExplosions() {
    const now = performance.now();
    for (let i = activeExplosions.length - 1; i >= 0; i--) {
        const ex = activeExplosions[i];
        const t = (now - ex.start) / ex.duration;
        if (t >= 1) {
            scene.remove(ex.sphere);
            scene.remove(ex.ring);
            ex.sphere.material.dispose();
            ex.ring.material.dispose();
            activeExplosions.splice(i, 1);
            continue;
        }
        ex.sphere.scale.setScalar(ex.baseRadius * (1 + t * 2.5));
        ex.sphere.material.opacity = 0.9 * (1 - t);
        ex.ring.scale.setScalar(ex.baseRadius * (1 + t * 5));
        ex.ring.material.opacity = 0.8 * (1 - t);
    }
}

function syncGimmick(g) {
    updateLava(g.lavaY);
}

let ws;
let lastSentInput = null;

function connect() {
    ws = new WebSocket(SERVER_URL);

    ws.addEventListener('open', () => {
        console.log('connected to game server');
        ws.send(JSON.stringify({ type: 'hello', playerKey: playerKey() }));
    });

    ws.addEventListener('close', () => {
        console.warn('disconnected from game server — reload to reconnect');
        
    });

    ws.addEventListener('error', (e) => console.error('websocket error', e));

    ws.addEventListener('message', (event) => {
        const msg = JSON.parse(event.data);

        if (msg.type === 'rooms') {
            if (msg.towerPool) towerPool = msg.towerPool;
            renderRoomList(msg.rooms);

        } else if (msg.type === 'room_created') {
            ws.send(JSON.stringify({ type: 'join_room', room: msg.roomId }));

        } else if (msg.type === 'join_pending') {
            joinPendingNoteEl.classList.remove('hidden');

        } else if (msg.type === 'join_error') {
            joinPendingNoteEl.classList.add('hidden');
            if (msg.reason === 'full') alert('That room is full (8/8 players).');
            else if (msg.reason === 'denied') alert('The host denied your request to join.');
            else if (msg.reason === 'host_left') alert('The host left before approving your request.');
            else if (msg.reason === 'closed') alert('That room closed — everyone left it.');

        } else if (msg.type === 'welcome') {
            myId = msg.id;
            myRoomKind = msg.roomKind;
            if (window.Autoplay) Autoplay.setMe(msg.id, msg.roomKind);
            currentPhase = msg.phase;
            myIsHost = !!msg.isHost;
            if (msg.towerPool) towerPool = msg.towerPool;
            roomMenuEl.classList.add('hidden');
            joinPendingNoteEl.classList.add('hidden');
            loadLevel(msg.level);
            ensurePlayerMesh(myId);
            let savedAdminToken = null;
            try { savedAdminToken = localStorage.getItem('adminToken'); } catch {}
            if (savedAdminToken) ws.send(JSON.stringify({ type: 'admin_token_auth', token: savedAdminToken }));
            updateLobbyVisibility(null);
            if (myIsHost && myRoomKind === 'main') {
                renderHostTowerSelect();
                hostTowerRowEl.classList.remove('hidden');
            }
            logToConsole('Press "/" to chat');

        } else if (msg.type === 'join_request') {
            addJoinRequest(msg.requestId);

        } else if (msg.type === 'level') {
            loadLevel(msg.level);

        } else if (msg.type === 'tower_vote') {
            showTowerVote(msg);

        } else if (msg.type === 'vote_tally') {
            voteTally = msg.tally || {};
            renderVote();

        } else if (msg.type === 'vote_result') {
            const won = voteChoices.find((c) => c.id === msg.towerId);
            logToConsole(`[NEXT TOWER: ${won ? won.name : msg.towerId}]`);

        } else if (msg.type === 'finish') {
            const place = ['1st', '2nd', '3rd'][msg.place - 1] || `${msg.place}th`;
            if (msg.id === myId) showRoundBanner(`YOU REACHED THE TOP — ${place}!`);
            logToConsole(msg.id === myId
                ? `[YOU FINISHED ${place}]`
                : `[PLAYER${msg.id} REACHED THE TOP — ${place}]`);

        } else if (msg.type === 'phase') {
            currentPhase = msg.phase;
            if (window.Autoplay) Autoplay.setPhase(msg.phase);
            if (msg.phase !== 'choosing') hideTowerChoice();
            updateLobbyVisibility(null);

        } else if (msg.type === 'join') {
            ensurePlayerMesh(msg.id);
            if (msg.id !== myId) logToConsole(`[PLAYER${msg.id} HAS JOINED THE GAME]`);

        } else if (msg.type === 'leave') {
            removePlayerMesh(msg.id);
            logToConsole(`[PLAYER${msg.id} HAS LEFT THE GAME]`);

        } else if (msg.type === 'state') {
            if (window.Autoplay) Autoplay.onState(msg);
            syncBananas(msg.bananas || []);
            for (const [idStr, pos] of Object.entries(msg.players)) {
                const id = Number(idStr);
                const entry = ensurePlayerMesh(id);
                entry.target.x = pos.x;
                entry.target.y = pos.y;
                entry.target.z = pos.z;
                if (id !== myId) entry.mesh.rotation.y = pos.angleY;
                setGlove(entry, !!pos.glove);
                setHat(entry, !!pos.hat);
                setFlame(entry, !!pos.boosting);

                if (entry.mesh.material.transparent !== !!pos.ghost) {
                    entry.mesh.material.transparent = !!pos.ghost;
                    entry.mesh.material.opacity = pos.ghost ? 0.25 : 1;
                }
                if (id === myId) ghostHintEl.classList.toggle('hidden', !pos.ghost);
            }
            
            
            
            for (const [idxStr, pos] of Object.entries(msg.platforms)) {
                const levelIndex = Number(idxStr) - 1;
                const mesh = platformMeshesByLevelIndex[levelIndex];
                if (mesh) mesh.position.set(pos.x, pos.y, pos.z);
            }

            syncMeteors(msg.meteors || []);
            processExplosions(msg.explosions || []);
            if (msg.gimmick) syncGimmick(msg.gimmick);

            currentPhase = msg.phase;
            if (msg.phase !== 'choosing') hideTowerChoice();
            updateLobbyVisibility(msg.players);
            roundTimerEl.classList.toggle('hidden', typeof msg.roundMsLeft !== 'number');
            if (typeof msg.roundMsLeft === 'number') roundTimerEl.textContent = formatRoundTime(msg.roundMsLeft);

        } else if (msg.type === 'round_result') {
            if (window.Autoplay) Autoplay.onResult(msg);
            if (msg.winner === myId) {
                showRoundBanner('YOU WIN!');
            } else if (msg.winner !== null) {
                showRoundBanner(`PLAYER ${msg.winner} WINS!`);
            } else {
                showRoundBanner("TIME'S UP — NO WINNER");
            }
            const finished = (msg.finishers || []).length;
            logToConsole(msg.winner !== null
                ? `[ROUND OVER — PLAYER${msg.winner} WON, ${finished} reached the top]`
                : '[ROUND OVER — NOBODY REACHED THE TOP IN TIME]');

        } else if (msg.type === 'admin_auth_result') {
            if (msg.ok) {
                adminAuthed = true;
                adminPanelEl.classList.remove('hidden');
                if (msg.token) {
                    try { localStorage.setItem('adminToken', msg.token); } catch {}
                }
                if (!msg.silent) logToConsole('authenticated — admin panel unlocked');
            } else if (!msg.silent) {
                logToConsole(msg.locked ? 'too many failed attempts — locked out temporarily' : 'incorrect code');
            }

        } else if (msg.type === 'profile') {
            myProfile = { coins: msg.coins, items: msg.items || [], wins: msg.wins || 0 };
            myKit.bananas = msg.bananas || 0;
            shopListings = msg.shop || shopListings;
            renderShop();
            if (msg.earned) {
                logToConsole(`+${msg.earned} coin${msg.earned === 1 ? '' : 's'} for the win — ${myProfile.coins} total`);
                coinCounterEl.classList.remove('coinGain');
                void coinCounterEl.offsetWidth;                 // restart the animation
                coinCounterEl.classList.add('coinGain');
            }
            if (msg.bought) logToConsole(`Bought ${(shopListings[msg.bought] || {}).name || msg.bought}`);
            else if (msg.reason === 'declined') logToConsole('Not enough coins for that');

        } else if (msg.type === 'kit') {
            myKit = { fuel: msg.fuel, bananas: msg.bananas };

        } else if (msg.type === 'slip') {
            spawnSlip(msg);
            if (msg.id === myId) shakeUntil = performance.now() + 320;

        } else if (msg.type === 'punch') {
            const puncher = remotePlayers.get(msg.id);
            if (puncher) puncher.swingUntil = performance.now() + SWING_MS;
            if (msg.id === myId) swingArm();
            const hit = (msg.hits || []).includes(myId);
            if (hit) shakeUntil = performance.now() + 220;

        } else if (msg.type === 'chat') {
            logToConsole((msg.id === myId ? 'You' : `Player ${msg.id}`) + ': ' + msg.text);
        }
    });
}
connect();

function sendInput() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (window.Autoplay && Autoplay.isRunning()) return;   // autoplay sends its own
    const payload = consoleOpen
        ? { type: 'input', keys: { w: false, a: false, s: false, d: false, jump: false, down: false, boost: false }, angleY }
        : {
              type: 'input',
              keys: {
                  w: !!keys['w'], a: !!keys['a'], s: !!keys['s'], d: !!keys['d'],
                  jump: !!keys[' '], down: !!keys['Shift'], boost: !!keys['r'],
              },
              angleY,
          };
    const serialized = JSON.stringify(payload);
    if (serialized === lastSentInput) return;
    lastSentInput = serialized;
    ws.send(serialized);
}

// Swinging is a click, and only does anything if you own the glove and are in
// a competitive round — the server checks both, this just avoids the noise.
let swingUntil = 0;
let shakeUntil = 0;

function swingArm() { swingUntil = performance.now() + SWING_MS; }

function canPunch() {
    return myProfile.items.includes('glove') && myRoomKind === 'main' && currentPhase === 'playing';
}

function canDropBanana() {
    return myProfile.items.includes('banana') && myRoomKind === 'main' &&
        currentPhase === 'playing' && myKit.bananas > 0;
}

renderer.domElement.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || consoleOpen) return;
    if (!myProfile.items.includes('glove')) return;

    // Always swing. Whether it connects is the server's call — it only counts
    // in a competitive round — but a glove that does nothing at all when you
    // click it just reads as broken.
    swingArm();
    const mine = remotePlayers.get(myId);
    if (mine) mine.swingUntil = performance.now() + SWING_MS;

    if (canPunch() && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'punch' }));
    }
});

const keys = {};

if (window.Autoplay) {
    // Autoplay transmits on its own schedule (jumps have to leave on an exact
    // tick), and steers the camera with the same angle it sends to the server.
    Autoplay.transmit = (autoKeys, autoAngle) => {
        angleY = autoAngle;
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'input', keys: autoKeys, angleY: autoAngle }));
        }
    };
    Autoplay.requestStartRound = () => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'start_round' }));
    };
    Autoplay.log = (text) => logToConsole(text);
}

window.addEventListener('keydown', (e) => {
    if (consoleOpen) {
        if (e.key === 'Escape') closeAdminConsole();
        return;
    }
    // Touching a movement key takes the controls back off the bot.
    if (window.Autoplay && Autoplay.isRunning() && ['w', 'a', 's', 'd', ' '].includes(e.key)) {
        Autoplay.stop();
    }
    if (e.key === 'q' || e.key === 'Q') {
        if (canDropBanana() && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'drop_banana' }));
        }
    }
    keys[e.key] = true;
    if (e.key === 'Tab') {
        e.preventDefault();
        mode = mode === 1 ? 3 : 1;
        const me = remotePlayers.get(myId);
        if (me) me.mesh.visible = mode === 3;
    } else if (e.key === '/') {
        e.preventDefault();
        openAdminConsole();
    }
});

window.addEventListener('keyup', (e) => { keys[e.key] = false; });

// --- Admin console / cheat panel ---

let consoleOpen = false;
let adminAuthed = false;
const adminConsoleEl = document.getElementById('adminConsole');
const chatLogEl = document.getElementById('chatLog');
const adminConsoleInputEl = document.getElementById('adminConsoleInput');
const adminPanelEl = document.getElementById('adminPanel');

const CHAT_MAX_LINES = 6;

function logToConsole(text) {
    const line = document.createElement('div');
    line.textContent = text;
    chatLogEl.appendChild(line);
    while (chatLogEl.children.length > CHAT_MAX_LINES) chatLogEl.removeChild(chatLogEl.firstChild);
}

const KNOWN_COMMANDS = ['help', 'fly', 'speed', 'gravity', 'jump', 'teleport', 'autoplay', 'logout'];

function openAdminConsole() {
    consoleOpen = true;
    adminConsoleEl.classList.remove('hidden');
    adminConsoleInputEl.value = '';
    adminConsoleInputEl.type = 'text';
    adminConsoleInputEl.focus();
    if (document.pointerLockElement === renderer.domElement) document.exitPointerLock();
}

const CODE_PREFIX = '**';
adminConsoleInputEl.addEventListener('input', () => {
    adminConsoleInputEl.type = adminConsoleInputEl.value.startsWith(CODE_PREFIX) ? 'password' : 'text';
});

function closeAdminConsole() {
    consoleOpen = false;
    adminConsoleEl.classList.add('hidden');
    adminConsoleInputEl.blur();
}

function adminFlyOn() {
    const el = document.getElementById('adminFly');
    return !!(el && el.checked);
}

function sendAdminCmd(cmd, value, target) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'admin_cmd', cmd, value, target }));
}

function sendChat(text) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'chat', text }));
}

function handleConsoleCommand(text) {
    const trimmed = text.trim();
    if (!trimmed) return;

    if (trimmed.startsWith(CODE_PREFIX)) {
        const code = trimmed.slice(CODE_PREFIX.length).trim();
        logToConsole('> ' + CODE_PREFIX + '*'.repeat(code.length));
        ws.send(JSON.stringify({ type: 'admin_auth', code }));
        return;
    }

    if (!adminAuthed) {
        sendChat(trimmed);
        return;
    }

    const [cmd, ...rest] = trimmed.split(/\s+/);

    if (!KNOWN_COMMANDS.includes(cmd)) {
        sendChat(trimmed);
        return;
    }

    logToConsole('> ' + trimmed);

    if (cmd === 'help') {
        logToConsole('commands: fly on|off, speed <n>, gravity <n>, jump <n>, teleport top|spawn,');
        logToConsole('          autoplay on|off|status, logout');
        return;
    }

    switch (cmd) {
        case 'fly':
            sendAdminCmd('fly', rest[0] !== 'off');
            document.getElementById('adminFly').checked = rest[0] !== 'off';
            break;
        case 'speed':
            sendAdminCmd('speed', Number(rest[0]));
            document.getElementById('adminSpeed').value = rest[0];
            break;
        case 'gravity':
            sendAdminCmd('gravity', Number(rest[0]));
            document.getElementById('adminGravity').value = rest[0];
            break;
        case 'jump':
            sendAdminCmd('jump', Number(rest[0]));
            document.getElementById('adminJump').value = rest[0];
            break;
        case 'teleport':
            sendAdminCmd('teleport', null, rest[0]);
            break;
        // Hands the controls to the climbing bot. Unlike the other cheats this
        // one is pure input: it plays the tower with w, space and the mouse,
        // under the same physics as everyone else.
        case 'autoplay': {
            if (!window.Autoplay) { logToConsole('autoplay unavailable'); break; }
            if (rest[0] === 'status') {
                const st = Autoplay.status();
                logToConsole(Autoplay.isRunning()
                    ? `climbing: platform ${st.step} of ${st.steps}, ${st.jumps} jumps, ${st.falls} falls`
                    : 'autoplay is off');
                break;
            }
            if (rest[0] === 'off') { Autoplay.stop(); break; }
            if (adminFlyOn()) logToConsole('note: fly is on — turn it off or the bot cannot land');
            Autoplay.start();
            closeAdminConsole();
            break;
        }
        case 'logout': {
            adminAuthed = false;
            adminPanelEl.classList.add('hidden');
            let storedToken = null;
            try {
                storedToken = localStorage.getItem('adminToken');
                localStorage.removeItem('adminToken');
            } catch {}
            ws.send(JSON.stringify({ type: 'admin_logout', token: storedToken }));
            logToConsole('logged out');
            break;
        }
        default:
            logToConsole('unknown command — type: help');
    }
}

adminConsoleInputEl.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
        handleConsoleCommand(adminConsoleInputEl.value);
        adminConsoleInputEl.value = '';
        adminConsoleInputEl.type = 'text';
    } else if (e.key === 'Escape') {
        closeAdminConsole();
    }
});

document.getElementById('adminFly').addEventListener('change', (e) => sendAdminCmd('fly', e.target.checked));
document.getElementById('adminSpeed').addEventListener('change', (e) => sendAdminCmd('speed', Number(e.target.value)));
document.getElementById('adminGravity').addEventListener('change', (e) => sendAdminCmd('gravity', Number(e.target.value)));
document.getElementById('adminJump').addEventListener('change', (e) => sendAdminCmd('jump', Number(e.target.value)));
document.getElementById('adminTpTop').addEventListener('click', () => sendAdminCmd('teleport', null, 'top'));
document.getElementById('adminTpSpawn').addEventListener('click', () => sendAdminCmd('teleport', null, 'spawn'));
document.getElementById('adminPanelClose').addEventListener('click', () => adminPanelEl.classList.add('hidden'));

window.addEventListener('click', (e) => {
    if (consoleOpen) return;
    if (e.target !== renderer.domElement) return;
    renderer.domElement.requestPointerLock();
});

document.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== renderer.domElement) return;
    angleY -= e.movementX * MOUSE_SENSITIVITY;
    angleX -= e.movementY * MOUSE_SENSITIVITY;
    angleX = Math.min(1.5, Math.max(angleX, -1.5));
});

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

const LERP_RATE = 0.25;

function animate() {
    requestAnimationFrame(animate);

    sendInput();

    const nowMs = performance.now();

    for (const entry of remotePlayers.values()) {
        entry.mesh.position.x += (entry.target.x - entry.mesh.position.x) * LERP_RATE;
        entry.mesh.position.y += (entry.target.y - entry.mesh.position.y) * LERP_RATE;
        entry.mesh.position.z += (entry.target.z - entry.mesh.position.z) * LERP_RATE;
        updateWorldGlove(entry, nowMs);
    }

    // Other players' bodies are turned by the angle the server sends; your own
    // follows the view directly, so in third person you can see which way you
    // are facing — and which way you just punched.
    const myEntry = remotePlayers.get(myId);
    if (myEntry) myEntry.mesh.rotation.y = angleY;

    for (const entry of meteorMeshes.values()) {
        entry.mesh.position.x += (entry.target.x - entry.mesh.position.x) * LERP_RATE;
        entry.mesh.position.y += (entry.target.y - entry.mesh.position.y) * LERP_RATE;
        entry.mesh.position.z += (entry.target.z - entry.mesh.position.z) * LERP_RATE;
    }

    updateExplosions();
    updateSlipPuffs(nowMs);

    const me = remotePlayers.get(myId);
    const playerHeight = 2;
    updateOwnGlove(nowMs);
    // Taking a punch shoves the view about for a moment, so it's obvious what
    // just happened to you.
    const shake = shakeUntil > nowMs ? (shakeUntil - nowMs) / 220 * 0.08 : 0;
    if (me) {
        if (mode === 1) {
            camera.rotation.y = angleY + (shake ? Math.sin(nowMs / 18) * shake : 0);
            camera.rotation.x = angleX + (shake ? Math.cos(nowMs / 23) * shake : 0);
            camera.position.x = me.mesh.position.x;
            camera.position.y = me.mesh.position.y + playerHeight * 0.5;
            camera.position.z = me.mesh.position.z;
        } else {
            const camDistance = 8;
            const camHeight = 4;

            const desiredX = me.mesh.position.x + Math.sin(angleY) * camDistance;
            const desiredZ = me.mesh.position.z + Math.cos(angleY) * camDistance;
            const desiredY = me.mesh.position.y + camHeight;

            const origin = new THREE.Vector3(
                me.mesh.position.x,
                me.mesh.position.y + playerHeight * 0.4,
                me.mesh.position.z
            );
            const desired = new THREE.Vector3(desiredX, desiredY, desiredZ);
            const dir = desired.clone().sub(origin);
            const fullDist = dir.length();
            dir.normalize();

            raycaster.set(origin, dir);
            raycaster.far = fullDist;
            const hits = raycaster.intersectObjects(collidableMeshes, false);

            let finalDist = fullDist;
            if (hits.length > 0) finalDist = Math.max(0.3, hits[0].distance - 0.3);

            camera.position.copy(origin.clone().add(dir.multiplyScalar(finalDist)));
            camera.lookAt(new THREE.Vector3(
                me.mesh.position.x,
                me.mesh.position.y + playerHeight * 0.5,
                me.mesh.position.z
            ));
        }
    }

    lavaOverlayEl.classList.toggle('hidden', camera.position.y >= currentLavaY);

    renderer.render(scene, camera);
    drawHeightHUD(me ? me.mesh.position.y : 0);
}

animate();
