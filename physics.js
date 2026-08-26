const {
    PLAYER_SIZE, PLAYER_SPEED, JUMP_VELOCITY, GRAVITY, TERMINAL_VELOCITY,
    SPAWN_POSITION, ground, level,
} = require('./levels');

function collidebox(posA, sizeA, posB, sizeB) {
    const halfA = { x: sizeA.width / 2, y: sizeA.height / 2, z: sizeA.depth / 2 };
    const halfB = { x: sizeB.width / 2, y: sizeB.height / 2, z: sizeB.depth / 2 };
    return (
        Math.abs(posA.x - posB.x) < (halfA.x + halfB.x) &&
        Math.abs(posA.y - posB.y) < (halfA.y + halfB.y) &&
        Math.abs(posA.z - posB.z) < (halfA.z + halfB.z)
    );
}

function collidesphere(spherePos, sphereRadius, boxPos, boxSize) {
    const halfBox = { x: boxSize.width / 2, y: boxSize.height / 2, z: boxSize.depth / 2 };
    const closestX = Math.max(boxPos.x - halfBox.x, Math.min(spherePos.x, boxPos.x + halfBox.x));
    const closestY = Math.max(boxPos.y - halfBox.y, Math.min(spherePos.y, boxPos.y + halfBox.y));
    const closestZ = Math.max(boxPos.z - halfBox.z, Math.min(spherePos.z, boxPos.z + halfBox.z));
    const dx = spherePos.x - closestX;
    const dy = spherePos.y - closestY;
    const dz = spherePos.z - closestZ;
    return (dx * dx + dy * dy + dz * dz) < (sphereRadius * sphereRadius);
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
    const tri = [
        { x: triPos.x, z: triPos.z - (2 / 3) * h },
        { x: triPos.x - size / 2, z: triPos.z + (1 / 3) * h },
        { x: triPos.x + size / 2, z: triPos.z + (1 / 3) * h },
    ];
    const hx = boxSize.width / 2, hz = boxSize.depth / 2;
    const box = [
        { x: boxPos.x - hx, z: boxPos.z - hz },
        { x: boxPos.x + hx, z: boxPos.z - hz },
        { x: boxPos.x + hx, z: boxPos.z + hz },
        { x: boxPos.x - hx, z: boxPos.z + hz },
    ];

    function project(points, axisX, axisZ) {
        let min = Infinity, max = -Infinity;
        for (const p of points) {
            const proj = p.x * axisX + p.z * axisZ;
            if (proj < min) min = proj;
            if (proj > max) max = proj;
        }
        return { min, max };
    }

    function overlapsOnAxis(axisX, axisZ) {
        const a = project(tri, axisX, axisZ);
        const b = project(box, axisX, axisZ);
        return a.max >= b.min && b.max >= a.min;
    }

    // box's own axes (equivalent to plain AABB overlap on x and z)
    if (!overlapsOnAxis(1, 0)) return false;
    if (!overlapsOnAxis(0, 1)) return false;

    // triangle edge normals
    for (let i = 0; i < 3; i++) {
        const p1 = tri[i], p2 = tri[(i + 1) % 3];
        const edgeX = p2.x - p1.x, edgeZ = p2.z - p1.z;
        if (!overlapsOnAxis(-edgeZ, edgeX)) return false;
    }

    return true;
}

function hitTestFor(object, sizeA) {
    if (object.shape === "sphere") {
        return (pos) => collidesphere(object.position, object.radius, pos, sizeA);
    } else if (object.shape === "cylinder") {
        return (pos) => collidecylinder(object.position, object.radius, object.length, object.axis || 'z', pos, sizeA);
    } else if (object.shape === "triangle") {
        return (pos) => collidetriangle(object.position, object.size, object.height, pos, sizeA);
    } else {
        return (pos) => collidebox(pos, sizeA, object.position, { width: object.width, height: object.height, depth: object.depth });
    }
}

function buildObjects() {
    const objects = [
        { position: { x: ground.x, y: ground.y, z: ground.z }, width: ground.width, height: ground.height, depth: ground.depth },
    ];
    for (const p of level) {
        objects.push({
            position: { x: p.x, y: p.y, z: p.z },
            shape: p.shape,
            width: p.width, height: p.height, depth: p.depth,
            radius: p.radius, length: p.length, size: p.size, axis: p.axis,
            special: p.special,
            startPos: p.startPos, endPos: p.endPos,
            moveT: p.special === "moving" ? 0 : undefined,
            moveDir: p.special === "moving" ? 1 : undefined,
            frameDelta: p.special === "moving" ? { x: 0, y: 0, z: 0 } : undefined,
        });
    }
    return objects;
}

function advanceMovingPlatforms(objects) {
    for (const object of objects) {
        if (object.special !== "moving") continue;
        const prev = { x: object.position.x, y: object.position.y, z: object.position.z };
        object.moveT += 0.01 * object.moveDir;
        if (object.moveT >= 1) { object.moveT = 1; object.moveDir = -1; }
        else if (object.moveT <= 0) { object.moveT = 0; object.moveDir = 1; }
        object.position.x = object.startPos.x + (object.endPos.x - object.startPos.x) * object.moveT;
        object.position.y = object.startPos.y + (object.endPos.y - object.startPos.y) * object.moveT;
        object.position.z = object.startPos.z + (object.endPos.z - object.startPos.z) * object.moveT;
        object.frameDelta = {
            x: object.position.x - prev.x,
            y: object.position.y - prev.y,
            z: object.position.z - prev.z,
        };
    }
}

const SPAWN_JITTER = 1.5;

function randomizedSpawnPosition() {
    return {
        x: SPAWN_POSITION.x + (Math.random() * 2 - 1) * SPAWN_JITTER,
        y: SPAWN_POSITION.y,
        z: SPAWN_POSITION.z + (Math.random() * 2 - 1) * SPAWN_JITTER,
    };
}

function createPlayer() {
    return {
        position: randomizedSpawnPosition(),
        y_vel: 0,
        on_ground: true,
        angleY: 0,
        dead: false,
        ridingPlatform: null,
        pendingDelta: { x: 0, y: 0, z: 0 },
        pushDelta: { x: 0, z: 0 },
        frameDelta: { x: 0, y: 0, z: 0 },
        admin: { authed: false, fly: false, speedMult: 1, gravityMult: 1, jumpMult: 1 },
    };
}

function resolveMovement(player, objects, keys, otherPlayers) {
    const admin = player.admin;

    if (admin && admin.fly) {
        const forward = { x: -Math.sin(player.angleY), z: -Math.cos(player.angleY) };
        const right = { x: Math.cos(player.angleY), z: -Math.sin(player.angleY) };
        const flySpeed = PLAYER_SPEED * admin.speedMult;

        let dx = 0, dy = 0, dz = 0;
        if (keys.w) { dx += forward.x * flySpeed; dz += forward.z * flySpeed; }
        if (keys.s) { dx -= forward.x * flySpeed; dz -= forward.z * flySpeed; }
        if (keys.d) { dx += right.x * flySpeed; dz += right.z * flySpeed; }
        if (keys.a) { dx -= right.x * flySpeed; dz -= right.z * flySpeed; }
        if (keys.jump) dy += flySpeed;
        if (keys.down) dy -= flySpeed;

        player.y_vel = 0;
        player.on_ground = false;
        player.ridingPlatform = null;
        player.pendingDelta = { x: dx, y: dy, z: dz };
        return;
    }

    if (player.ridingPlatform && player.ridingPlatform.frameDelta) {
        player.position.x += player.ridingPlatform.frameDelta.x;
        player.position.y += player.ridingPlatform.frameDelta.y;
        player.position.z += player.ridingPlatform.frameDelta.z;
    }

    const forward = { x: -Math.sin(player.angleY), z: -Math.cos(player.angleY) };
    const right = { x: Math.cos(player.angleY), z: -Math.sin(player.angleY) };

    const speed = admin ? PLAYER_SPEED * admin.speedMult : PLAYER_SPEED;
    const jumpVelocity = admin ? JUMP_VELOCITY * admin.jumpMult : JUMP_VELOCITY;
    const gravity = admin ? GRAVITY * admin.gravityMult : GRAVITY;

    let dx = 0, dy = 0, dz = 0;
    if (keys.w) { dx += forward.x * speed; dz += forward.z * speed; }
    if (keys.s) { dx -= forward.x * speed; dz -= forward.z * speed; }
    if (keys.d) { dx += right.x * speed; dz += right.z * speed; }
    if (keys.a) { dx -= right.x * speed; dz -= right.z * speed; }
    if (keys.jump && player.on_ground) player.y_vel = jumpVelocity;

    player.y_vel -= gravity;
    if (player.y_vel < TERMINAL_VELOCITY) player.y_vel = TERMINAL_VELOCITY;
    dy = player.y_vel;

    player.on_ground = false;
    player.ridingPlatform = null;

    const sizeA = PLAYER_SIZE;

    const collidables = otherPlayers && otherPlayers.length
        ? objects.concat(otherPlayers.map((op) => ({
              position: op.position,
              width: PLAYER_SIZE.width,
              height: PLAYER_SIZE.height,
              depth: PLAYER_SIZE.depth,
              isPlayer: true,
              ref: op,
          })))
        : objects;

    const dy0 = dy;
    let bestLandDy = null;
    let bestLandObject = null;
    let bestCeilDy = null;

    for (const object of collidables) {
        let objTop, objBottom;
        if (object.shape === "sphere" || object.shape === "cylinder") {
            objTop = object.position.y + object.radius;
            objBottom = object.position.y - object.radius;
        } else {
            objTop = object.position.y + object.height / 2;
            objBottom = object.position.y - object.height / 2;
        }

        const hits = hitTestFor(object, sizeA);

        const newYPos = { x: player.position.x, y: player.position.y + dy0, z: player.position.z };
        if (hits(newYPos)) {
            const currentFoot = player.position.y - sizeA.height / 2;
            if (player.y_vel < 0 && objTop <= currentFoot + 0.05) {
                const candidateDy = objTop - (player.position.y - sizeA.height / 2);
                if (bestLandDy === null || candidateDy > bestLandDy) {
                    bestLandDy = candidateDy;
                    bestLandObject = object;
                }
            } else if (player.y_vel >= 0) {
                const candidateDy = objBottom - (player.position.y + sizeA.height / 2);
                if (bestCeilDy === null || candidateDy < bestCeilDy) {
                    bestCeilDy = candidateDy;
                }
            }
        }

        const newXPos = { x: player.position.x + dx, y: player.position.y, z: player.position.z };
        if (hits(newXPos)) {
            if (object.isPlayer) { object.ref.pushDelta.x += dx; dx = 0; }
            else dx = 0;
        }

        const newZPos = { x: player.position.x, y: player.position.y, z: player.position.z + dz };
        if (hits(newZPos)) {
            if (object.isPlayer) { object.ref.pushDelta.z += dz; dz = 0; }
            else dz = 0;
        }
    }

    if (bestLandDy !== null) {
        player.on_ground = true;
        dy = bestLandDy;
        if (bestLandObject.special === "moving") player.ridingPlatform = bestLandObject;
        else if (bestLandObject.isPlayer) player.ridingPlatform = bestLandObject.ref;
        player.y_vel = 0;
    } else if (bestCeilDy !== null) {
        dy = bestCeilDy;
        player.y_vel = 0;
    }

    player.pendingDelta = { x: dx, y: dy, z: dz };
}

function resolvePush(player, pushDelta, objects, otherPlayers) {
    let dx = pushDelta.x, dz = pushDelta.z;
    let blockedByX = null, blockedByZ = null;
    if (dx === 0 && dz === 0) return { x: 0, z: 0, blockedByX, blockedByZ };

    const sizeA = PLAYER_SIZE;
    const solids = objects.filter((o) => o.special !== "kill");
    const others = otherPlayers.map((op) => ({
        position: op.position,
        width: PLAYER_SIZE.width, height: PLAYER_SIZE.height, depth: PLAYER_SIZE.depth,
        isPlayer: true, ref: op,
    }));
    const collidables = solids.concat(others);

    for (const object of collidables) {
        const hits = hitTestFor(object, sizeA);
        if (dx !== 0) {
            const newXPos = { x: player.position.x + dx, y: player.position.y, z: player.position.z };
            if (hits(newXPos)) { if (object.isPlayer) blockedByX = object.ref; dx = 0; }
        }
        if (dz !== 0) {
            const newZPos = { x: player.position.x, y: player.position.y, z: player.position.z + dz };
            if (hits(newZPos)) { if (object.isPlayer) blockedByZ = object.ref; dz = 0; }
        }
    }

    return { x: dx, z: dz, blockedByX, blockedByZ };
}

function applyPendingMove(player, objects) {
    const { x: dx, y: dy, z: dz } = player.pendingDelta;
    const newPos = { x: player.position.x + dx, y: player.position.y + dy, z: player.position.z + dz };

    const flying = player.admin && player.admin.fly;
    if (!flying) {
        for (const object of objects) {
            if (object.special !== "kill") continue;
            const hits = hitTestFor(object, PLAYER_SIZE);
            if (hits(newPos)) { player.dead = true; break; }
        }
    }

    if (player.dead) {
        player.position = randomizedSpawnPosition();
        player.y_vel = 0;
        player.on_ground = false;
        player.ridingPlatform = null;
        player.frameDelta = { x: 0, y: 0, z: 0 };
        player.dead = false;
        return;
    }

    player.position.x += dx;
    player.position.y += dy;
    player.position.z += dz;
    player.frameDelta = { x: dx, y: dy, z: dz };
}

module.exports = { buildObjects, advanceMovingPlatforms, createPlayer, resolveMovement, resolvePush, applyPendingMove };
