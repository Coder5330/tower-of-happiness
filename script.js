
const MOUSE_SENSITIVITY = 0.002;
const TOWER_HEIGHT = 60;
const GROUND_AREA = 40

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);
scene.fog = new THREE.Fog(0x87ceeb, 20, 150);

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

const player = {
    mesh: new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshStandardMaterial({ color: 0xff4500 })
    ),
    speed: 0.1,
    y_vel: 0,
    on_ground: true,
    width: 1,
    height: 2,
    depth: 1,
    angleY: 0,
    angleX: 0,
    dead: false,
};
player.mesh.visible = false;
player.mesh.position.set(-5, 5, 0);
scene.add(player.mesh);

const groundData = { width: GROUND_AREA, height: 1, depth: GROUND_AREA };
const ground = new THREE.Mesh(
    new THREE.BoxGeometry(groundData.width, groundData.height, groundData.depth),
    new THREE.MeshStandardMaterial({ color: 0x228b22 })
);
ground.position.set(0, -0.5, 0);
scene.add(ground);

const objects = [
    { position: ground.position, width: groundData.width, height: groundData.height, depth: groundData.depth }
];

function addPlatform(p) {
    let geometry;
    let mesh;

    if (p.shape === "sphere") {
        geometry = new THREE.SphereGeometry(p.radius, 16, 16);
        mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: p.color }));

    } else if (p.shape === "cylinder") {
        geometry = new THREE.CylinderGeometry(p.radius, p.radius, p.length, 12);
        mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: p.color }));
        if (p.axis === 'x') {
            mesh.rotation.z = Math.PI / 2;
        } else {
            mesh.rotation.x = Math.PI / 2;
        }

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

    objects.push({
        position: mesh.position,
        mesh: mesh,
        shape: p.shape,
        width: p.width,
        height: p.height,
        depth: p.depth,
        radius: p.radius,
        length: p.length,
        size: p.size,
        special: p.special,
        startPos: p.startPos,
        endPos: p.endPos,
    });
}

const levels = [
    [
        { x: 0, y: TOWER_HEIGHT / 2, z: GROUND_AREA / 2 - 0.5, width: GROUND_AREA, height: TOWER_HEIGHT, depth: 1, color: 0x0000ff, type: "wall" },
        { x: 0, y: TOWER_HEIGHT / 2, z: -GROUND_AREA / 2 + 0.5, width: GROUND_AREA, height: TOWER_HEIGHT, depth: 1, color: 0x0000ff, type: "wall" },
        { x: -GROUND_AREA / 2 + 0.5, y: TOWER_HEIGHT / 2, z: 0, width: 1, height: TOWER_HEIGHT, depth: GROUND_AREA, color: 0x0000ff, type: "wall" },
        { x: GROUND_AREA / 2 - 0.5, y: TOWER_HEIGHT / 2, z: 0, width: 1, height: TOWER_HEIGHT, depth: GROUND_AREA, color: 0x0000ff, type: "wall" },
        // stepping stones — small, spaced, force careful footing
        { x: 0, y: 2, z: 6, shape: "box", width: 1.5, height: 0.5, depth: 1.5, color: 0x2ecc71, special: null },
        { x: 2, y: 3, z: 3, shape: "sphere", radius: 0.9, height: 0.5, color: 0x2ecc71, special: null },
        { x: 1, y: 4, z: 0, shape: "box", width: 1.2, height: 0.5, depth: 1.2, color: 0x2ecc71, special: null },
        { x: 3, y: 4.5, z: -2, shape: "triangle", size: 1.6, height: 0.5, color: 0x2ecc71, special: null },

        // first kill zone — a spike to route around, not stand on
        { x: 2.5, y: 5, z: -0.5, shape: "cylinder", radius: 0.3, length: 2, color: 0xff0000, special: "kill" },

        // rest platform
        { x: 4, y: 5, z: -3, shape: "box", width: 4, height: 0.5, depth: 4, color: 0xf1c40f, special: null },

        // cylinder tightrope
        { x: 4, y: 7, z: -9, shape: "cylinder", radius: 0.35, length: 8, color: 0xe74c3c, special: null },

        // moving platform bridging a gap the player can't clear standing still
        { x: 8, y: 8, z: -12, shape: "box", width: 2, height: 0.5, depth: 2, color: 0x1abc9c, special: "moving",
            startPos: { x: 8, y: 8, z: -12 }, endPos: { x: 12, y: 8, z: -12 } },

        // staircase — evenly spaced small steps climbing steadily
        { x: 14, y: 9.5, z: -12, shape: "box", width: 1.5, height: 0.5, depth: 1.5, color: 0x3498db, special: null },
        { x: 15, y: 11, z: -9, shape: "sphere", radius: 0.9, height: 0.5, color: 0x3498db, special: null },
        { x: 15, y: 12.5, z: -6, shape: "box", width: 1.5, height: 0.5, depth: 1.5, color: 0x3498db, special: null },
        { x: 13, y: 14, z: -4, shape: "triangle", size: 1.4, height: 0.5, color: 0x3498db, special: null },

        // second cylinder tightrope, perpendicular
        { x: 9, y: 15.5, z: -3, shape: "cylinder", radius: 0.35, length: 8, color: 0xe74c3c, special: null },

        // rest platform
        { x: 4, y: 16.5, z: -2, shape: "box", width: 3.5, height: 0.5, depth: 3.5, color: 0xf1c40f, special: null },

        // moving platform over a kill-floor gap
        { x: 0, y: 18, z: 2, shape: "box", width: 2, height: 0.5, depth: 2, color: 0x1abc9c, special: "moving",
            startPos: { x: 0, y: 18, z: 2 }, endPos: { x: 0, y: 18, z: 8 } },

        // narrow zigzag stones
        { x: -3, y: 20, z: 9, shape: "sphere", radius: 0.7, height: 0.5, color: 0x9b59b6, special: null },
        { x: -6, y: 22, z: 7, shape: "box", width: 1, height: 0.5, depth: 1, color: 0x9b59b6, special: null },
        { x: -8, y: 24, z: 4, shape: "triangle", size: 1.2, height: 0.5, color: 0x9b59b6, special: null },
        { x: -6, y: 26, z: 1, shape: "sphere", radius: 0.7, height: 0.5, color: 0x9b59b6, special: null },

        // spinning-feel hazard row — several kill cylinders in a line to weave through
        { x: -4, y: 27, z: -1, shape: "cylinder", radius: 0.3, length: 1.5, color: 0xff0000, special: "kill" },
        { x: -2, y: 27, z: -1, shape: "cylinder", radius: 0.3, length: 1.5, color: 0xff0000, special: "kill" },

        // rest platform before the long moving-platform gauntlet
        { x: -3, y: 28, z: -3, shape: "box", width: 3.5, height: 0.5, depth: 3.5, color: 0xf1c40f, special: null },

        // long vertical-travel moving platform — rises while you're on it
        { x: -3, y: 30, z: -8, shape: "box", width: 2, height: 0.5, depth: 2, color: 0x1abc9c, special: "moving",
            startPos: { x: -3, y: 30, z: -8 }, endPos: { x: -3, y: 36, z: -8 } },

        // tight stepping run
        { x: -1, y: 38, z: -6, shape: "box", width: 1, height: 0.5, depth: 1, color: 0x2ecc71, special: null },
        { x: 2, y: 40, z: -8, shape: "triangle", size: 1, height: 0.5, color: 0x2ecc71, special: null },
        { x: 5, y: 42, z: -6, shape: "sphere", radius: 0.6, height: 0.5, color: 0x2ecc71, special: null },
        { x: 6, y: 44, z: -2, shape: "box", width: 1, height: 0.5, depth: 1, color: 0x2ecc71, special: null },

        // final long tightrope, thinnest yet
        { x: 3, y: 46, z: 2, shape: "cylinder", radius: 0.25, length: 9, color: 0xe74c3c, special: null },

        // last moving platform, horizontal sweep right before the goal
        { x: 3, y: 48, z: 8, shape: "box", width: 2, height: 0.5, depth: 2, color: 0x1abc9c, special: "moving",
            startPos: { x: -1, y: 48, z: 8 }, endPos: { x: 5, y: 48, z: 8 } },

        // final stretch of tiny stones — hardest section, right before the goal
        { x: 4, y: 51, z: 4, shape: "sphere", radius: 0.5, height: 0.5, color: 0x9b59b6, special: null },
        { x: 3, y: 53, z: 1, shape: "triangle", size: 1.8, height: 0.5, color: 0x9b59b6, special: null },
        { x: 0, y: 55, z: 2, shape: "box", width: 0.8, height: 0.5, depth: 0.8, color: 0x9b59b6, special: null },
        { x: 0, y: 57, z: 4, shape: "box", width: 0.8, height: 0.5, depth: 0.8, color: 0x9b59b6, special: null },

        // goal — big, gold, unmissable
        { x: 3, y: 58, z: 6, shape: "box", width: 5, height: 0.5, depth: 5, color: 0xf1c40f, special: null },
    ]
];

let currentLevel = 0;
const level = levels[currentLevel];
level.forEach((p) => {
    addPlatform(p);
});

function randint(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
}

function makeCloud(x, y, z) {
    const cloud = new THREE.Group();
    const cloudMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff });

    const puffCount = randint(5, 8);
    for (let i = 0; i < puffCount; i++) {
        const radius = 3 + Math.random() * 3;
        const puffGeometry = new THREE.SphereGeometry(radius, 8, 8);
        const puff = new THREE.Mesh(puffGeometry, cloudMaterial);

        puff.position.set(
            (Math.random() - 0.5) * 12,
            (Math.random() - 0.5) * 3,
            (Math.random() - 0.5) * 6
        );
        cloud.add(puff);
    }

    cloud.position.set(x, y, z);
    scene.add(cloud);
    return cloud;
}

const sunGeometry = new THREE.SphereGeometry(20, 16, 16);
const sunMaterial = new THREE.MeshBasicMaterial({ color: 0xfff5cc });
const sun = new THREE.Mesh(sunGeometry, sunMaterial);
const sunDistance = 400;
const lightDir = new THREE.Vector3(5, 10, 7).normalize();
sun.position.copy(lightDir).multiplyScalar(sunDistance);
scene.add(sun);

const cloudMinDistanceY = 50;
const cloudMaxDistanceY = 150;
const cloudMinDistance = -150;
const cloudMaxDistance = 150;

const clouds = [];
for (let i = 0; i < randint(5, 30); i++) {
    clouds.push(makeCloud(
        randint(cloudMinDistance, cloudMaxDistance),
        randint(cloudMinDistanceY, cloudMaxDistanceY),
        randint(cloudMinDistance, cloudMaxDistance)
    ));
}

const keys = {};

function collidebox(posA, sizeA, posB, sizeB) {
    const halfA = { x: sizeA.width / 2, y: sizeA.height / 2, z: sizeA.depth / 2 };
    const halfB = { x: sizeB.width / 2, y: sizeB.height / 2, z: sizeB.depth / 2 };
    const overlapX = Math.abs(posA.x - posB.x) < (halfA.x + halfB.x);
    const overlapY = Math.abs(posA.y - posB.y) < (halfA.y + halfB.y);
    const overlapZ = Math.abs(posA.z - posB.z) < (halfA.z + halfB.z);
    return overlapX && overlapY && overlapZ;
}

function collidesphere(spherePos, sphereRadius, boxPos, boxSize) {
    const halfBox = { x: boxSize.width / 2, y: boxSize.height / 2, z: boxSize.depth / 2 };
    const closestX = Math.max(boxPos.x - halfBox.x, Math.min(spherePos.x, boxPos.x + halfBox.x));
    const closestY = Math.max(boxPos.y - halfBox.y, Math.min(spherePos.y, boxPos.y + halfBox.y));
    const closestZ = Math.max(boxPos.z - halfBox.z, Math.min(spherePos.z, boxPos.z + halfBox.z));
    const dx = spherePos.x - closestX;
    const dy = spherePos.y - closestY;
    const dz = spherePos.z - closestZ;
    const distanceSquared = dx * dx + dy * dy + dz * dz;

    return distanceSquared < (sphereRadius * sphereRadius);
}

function collidecylinder(cylinderPos, radius, length, axis, boxPos, boxSize) {
    const halfLength = length / 2;
    const closest = { x: cylinderPos.x, y: cylinderPos.y, z: cylinderPos.z };

    if (axis === 'x') {
        closest.x = Math.max(cylinderPos.x - halfLength, Math.min(boxPos.x, cylinderPos.x + halfLength));
    } else {
        closest.z = Math.max(cylinderPos.z - halfLength, Math.min(boxPos.z, cylinderPos.z + halfLength));
    }
    return collidesphere(closest, radius, boxPos, boxSize);
}
function collidetriangle(triPos, size, height, boxPos, boxSize) {
    const halfHeight = height / 2;
    if (boxPos.y + boxSize.height / 2 < triPos.y - halfHeight ||
        boxPos.y - boxSize.height / 2 > triPos.y + halfHeight) {
        return false;
    }

    const h = size * Math.sqrt(3) / 2;
    const p1 = { x: triPos.x,            z: triPos.z - (2 / 3) * h };
    const p2 = { x: triPos.x - size / 2, z: triPos.z + (1 / 3) * h };
    const p3 = { x: triPos.x + size / 2, z: triPos.z + (1 / 3) * h };
    function sign(ax, az, bx, bz, cx, cz) {
        return (ax - cx) * (bz - cz) - (bx - cx) * (az - cz);
    }

    const d1 = sign(boxPos.x, boxPos.z, p1.x, p1.z, p2.x, p2.z);
    const d2 = sign(boxPos.x, boxPos.z, p2.x, p2.z, p3.x, p3.z);
    const d3 = sign(boxPos.x, boxPos.z, p3.x, p3.z, p1.x, p1.z);

    const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
    const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);

    return !(hasNeg && hasPos);
}

function move() {
    const forward = {
        x: -Math.sin(player.angleY),
        z: -Math.cos(player.angleY)
    };

    const right = {
        x: Math.cos(player.angleY),
        z: -Math.sin(player.angleY)
    };

    let dx = 0;
    let dy = 0;
    let dz = 0;

    if (keys["w"]) { dx += forward.x * player.speed; dz += forward.z * player.speed; }
    if (keys["s"]) { dx -= forward.x * player.speed; dz -= forward.z * player.speed; }
    if (keys["d"]) { dx += right.x * player.speed;   dz += right.z * player.speed;   }
    if (keys["a"]) { dx -= right.x * player.speed;   dz -= right.z * player.speed;   }
    if (keys[" "] && player.on_ground) player.y_vel = 0.28;

    player.y_vel -= 0.015;
    if (player.y_vel < -0.4) player.y_vel = -0.4;
    dy = player.y_vel;

    player.on_ground = false;

    objects.forEach((object) => {
        const sizeA = { width: player.width, height: player.height, depth: player.depth };
    
        let objTop, objBottom, hits;
    
        if (object.shape === "sphere") {
            objTop = object.position.y + object.radius;
            objBottom = object.position.y - object.radius;
            hits = (pos) => collidesphere(object.position, object.radius, pos, sizeA);
    
        } else if (object.shape === "cylinder") {
            objTop = object.position.y + object.radius;
            objBottom = object.position.y - object.radius;
            hits = (pos) => collidecylinder(object.position, object.radius, object.length, object.axis || 'z', pos, sizeA);
    
        } else if (object.shape === "triangle") {
            objTop = object.position.y + object.height / 2;
            objBottom = object.position.y - object.height / 2;
            hits = (pos) => collidetriangle(object.position, object.size, object.height, pos, sizeA);
    
        } else {
            objTop = object.position.y + object.height / 2;
            objBottom = object.position.y - object.height / 2;
            hits = (pos) => collidebox(pos, sizeA, object.position, { width: object.width, height: object.height, depth: object.depth });
        }
    
        const newYPos = {
            x: player.mesh.position.x,
            y: player.mesh.position.y + dy,
            z: player.mesh.position.z,
        };
        if (hits(newYPos)) {
            if (player.y_vel < 0) {
                player.on_ground = true;
                dy = objTop - (player.mesh.position.y - player.height / 2);
            } else {
                dy = objBottom - (player.mesh.position.y + player.height / 2);
            }
            player.y_vel = 0;
        }
    
        const newXPos = {
            x: player.mesh.position.x + dx,
            y: player.mesh.position.y,
            z: player.mesh.position.z,
        };
        if (hits(newXPos)) {
            dx = 0;
        }
    
        const newZPos = {
            x: player.mesh.position.x,
            y: player.mesh.position.y,
            z: player.mesh.position.z + dz,
        };
        if (hits(newZPos)) {
            dz = 0;
        }
    });

    objects.forEach((object) => {
        if (object.special === "moving") {
            if (object.moveT === undefined) object.moveT = 0;
            if (object.moveDir === undefined) object.moveDir = 1;
        
            object.moveT += 0.005 * object.moveDir;
        
            if (object.moveT >= 1) {
                object.moveT = 1;
                object.moveDir = -1;
            } else if (object.moveT <= 0) {
                object.moveT = 0;
                object.moveDir = 1;
            }
        
            object.mesh.position.x = object.startPos.x + (object.endPos.x - object.startPos.x) * object.moveT;
            object.mesh.position.y = object.startPos.y + (object.endPos.y - object.startPos.y) * object.moveT;
            object.mesh.position.z = object.startPos.z + (object.endPos.z - object.startPos.z) * object.moveT;
        }
    });

    objects.forEach((object) => {
        if (object.special === "kill") {
            const new_player = {
                pos: { 
                    x: player.mesh.position.x + dx,
                    y: player.mesh.position.y + dy,
                    z: player.mesh.position.z + dz,
                },
                width: player.width,
                height: player.height,
                depth: player.depth
            }
            const new_object = {
                pos: { 
                    x: object.position.x,
                    y: object.position.y,
                    z: object.position.z,
                },
                width: object.width,
                height: object.height,
                depth: object.depth
            }
            if (collidebox(new_player.pos, { width: new_player.width, height: new_player.height, depth: new_player.depth },
                new_object.pos, { width: new_object.width, height: new_object.height, depth: new_object.depth })) {
                player.dead = true;
            }
        }
    })

    player.mesh.position.x += dx;
    player.mesh.position.y += dy;
    player.mesh.position.z += dz;

    camera.rotation.y = player.angleY;
    camera.rotation.x = player.angleX;

    camera.position.x = player.mesh.position.x;
    camera.position.y = player.mesh.position.y + player.height * 0.5;
    camera.position.z = player.mesh.position.z;
}

function animate() {
    requestAnimationFrame(animate);
    move();
    if (player.dead) {
        player.mesh.position.set(-5, 5, 0);
    }
    renderer.render(scene, camera);
}

animate();

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

window.addEventListener('keydown', (e) => {
    keys[e.key] = true;
});

window.addEventListener('keyup', (e) => {
    keys[e.key] = false;
});

window.addEventListener('click', () => {
    renderer.domElement.requestPointerLock();
});

document.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== renderer.domElement) return;
    player.angleY -= e.movementX * MOUSE_SENSITIVITY;
    player.angleX -= e.movementY * MOUSE_SENSITIVITY;
    player.angleX = Math.min(1.5, Math.max(player.angleX, -1.5));
});