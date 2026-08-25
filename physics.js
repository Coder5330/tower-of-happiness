const {
    PLAYER_SIZE, PLAYER_SPEED, JUMP_VELOCITY, GRAVITY, TERMINAL_VELOCITY,
    SPAWN_POSITION, ground, level,
} = require('./levelData');

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
    const p1 = { x: triPos.x, z: triPos.z - (2 / 3) * h };
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

function createPlayer() {
    return {
        position: { ...SPAWN_POSITION },
        y_vel: 0,
        on_ground: true,
        angleY: 0,
        dead: false,
        ridingPlatform: null,
        pendingDelta: { x: 0, y: 0, z: 0 },
    };
}

function resolveMovement(player, objects, keys, otherPlayers) {
    if (player.ridingPlatform && player.ridingPlatform.frameDelta) {
        player.position.x += player.ridingPlatform.frameDelta.x;
        player.position.y += player.ridingPlatform.frameDelta.y;
        player.position.z += player.ridingPlatform.frameDelta.z;
    }

    const forward = { x: -Math.sin(player.angleY), z: -Math.cos(player.angleY) };
    const right = { x: Math.cos(player.angleY), z: -Math.sin(player.angleY) };

    let dx = 0, dy = 0, dz = 0;
    if (keys.w) { dx += forward.x * PLAYER_SPEED; dz += forward.z * PLAYER_SPEED; }
    if (keys.s) { dx -= forward.x * PLAYER_SPEED; dz -= forward.z * PLAYER_SPEED; }
    if (keys.d) { dx += right.x * PLAYER_SPEED; dz += right.z * PLAYER_SPEED; }
    if (keys.a) { dx -= right.x * PLAYER_SPEED; dz -= right.z * PLAYER_SPEED; }
    if (keys.jump && player.on_ground) player.y_vel = JUMP_VELOCITY;

    player.y_vel -= GRAVITY;
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
          })))
        : objects;

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

        const newYPos = { x: player.position.x, y: player.position.y + dy, z: player.position.z };
        if (hits(newYPos)) {
            if (player.y_vel < 0) {
                player.on_ground = true;
                dy = objTop - (player.position.y - sizeA.height / 2);
                if (object.special === "moving") player.ridingPlatform = object;
            } else {
                dy = objBottom - (player.position.y + sizeA.height / 2);
            }
            player.y_vel = 0;
        }

        const newXPos = { x: player.position.x + dx, y: player.position.y, z: player.position.z };
        if (hits(newXPos)) dx = 0;

        const newZPos = { x: player.position.x, y: player.position.y, z: player.position.z + dz };
        if (hits(newZPos)) dz = 0;
    }

    player.pendingDelta = { x: dx, y: dy, z: dz };
}

function applyPendingMove(player, objects) {
    const { x: dx, y: dy, z: dz } = player.pendingDelta;
    const newPos = { x: player.position.x + dx, y: player.position.y + dy, z: player.position.z + dz };

    for (const object of objects) {
        if (object.special !== "kill") continue;
        const hits = hitTestFor(object, PLAYER_SIZE);
        if (hits(newPos)) { player.dead = true; break; }
    }

    if (player.dead) {
        player.position = { ...SPAWN_POSITION };
        player.y_vel = 0;
        player.on_ground = false;
        player.ridingPlatform = null;
        player.dead = false;
        return;
    }

    player.position.x += dx;
    player.position.y += dy;
    player.position.z += dz;
}

module.exports = { buildObjects, advanceMovingPlatforms, createPlayer, resolveMovement, applyPendingMove };
