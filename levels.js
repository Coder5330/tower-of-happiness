const TOWER_HEIGHT = 60;
const GROUND_AREA = 40;

const PLAYER_SIZE = { width: 1, height: 2, depth: 1 };
const PLAYER_SPEED = 0.1;
const JUMP_VELOCITY = 0.28;
const GRAVITY = 0.015;
const TERMINAL_VELOCITY = -0.4;
const SPAWN_POSITION = { x: -5, y: 5, z: 0 };

const ground = { x: 0, y: -0.5, z: 0, width: GROUND_AREA, height: 1, depth: GROUND_AREA };

const level = [
    { x: 0, y: TOWER_HEIGHT / 2, z: GROUND_AREA / 2 - 0.5, width: GROUND_AREA, height: TOWER_HEIGHT, depth: 1 },
    { x: 0, y: TOWER_HEIGHT / 2, z: -GROUND_AREA / 2 + 0.5, width: GROUND_AREA, height: TOWER_HEIGHT, depth: 1 },
    { x: -GROUND_AREA / 2 + 0.5, y: TOWER_HEIGHT / 2, z: 0, width: 1, height: TOWER_HEIGHT, depth: GROUND_AREA },
    { x: GROUND_AREA / 2 - 0.5, y: TOWER_HEIGHT / 2, z: 0, width: 1, height: TOWER_HEIGHT, depth: GROUND_AREA },
    { x: 0, y: 2, z: 6, shape: "box", width: 1.5, height: 0.5, depth: 1.5 },
    { x: 2, y: 3, z: 3, shape: "sphere", radius: 0.9, height: 0.5 },
    { x: 1, y: 4, z: 0, shape: "box", width: 1.2, height: 0.5, depth: 1.2 },
    { x: 3, y: 4.5, z: -2, shape: "triangle", size: 1.6, height: 0.5 },
    { x: 2.5, y: 5, z: -0.5, shape: "cylinder", radius: 0.3, length: 2, special: "kill" },
    { x: 4, y: 5, z: -3, shape: "box", width: 4, height: 0.5, depth: 4 },
    { x: 4, y: 7, z: -9, shape: "cylinder", radius: 0.35, length: 8 },
    { x: 8, y: 8, z: -12, shape: "box", width: 2, height: 0.5, depth: 2, special: "moving",
        startPos: { x: 8, y: 8, z: -12 }, endPos: { x: 12, y: 8, z: -12 } },
    { x: 14, y: 9.5, z: -12, shape: "box", width: 1.5, height: 0.5, depth: 1.5 },
    { x: 15, y: 11, z: -9, shape: "sphere", radius: 0.9, height: 0.5 },
    { x: 15, y: 12.5, z: -6, shape: "box", width: 1.5, height: 0.5, depth: 1.5 },
    { x: 13, y: 14, z: -4, shape: "triangle", size: 1.4, height: 0.5 },
    { x: 9, y: 15.5, z: -3, shape: "cylinder", radius: 0.35, length: 8 },
    { x: 4, y: 16.5, z: -2, shape: "box", width: 3.5, height: 0.5, depth: 3.5 },
    { x: 0, y: 18, z: 2, shape: "box", width: 2, height: 0.5, depth: 2, special: "moving",
        startPos: { x: 0, y: 18, z: 2 }, endPos: { x: 0, y: 18, z: 8 } },
    { x: -3, y: 20, z: 9, shape: "sphere", radius: 0.7, height: 0.5 },
    { x: -6, y: 22, z: 7, shape: "box", width: 1, height: 0.5, depth: 1 },
    { x: -8, y: 24, z: 4, shape: "triangle", size: 1.2, height: 0.5 },
    { x: -6, y: 26, z: 1, shape: "sphere", radius: 0.7, height: 0.5 },
    { x: -4, y: 27, z: -1, shape: "cylinder", radius: 0.3, length: 1.5, special: "kill" },
    { x: -2, y: 27, z: -1, shape: "cylinder", radius: 0.3, length: 1.5, special: "kill" },
    { x: -3, y: 28, z: -3, shape: "box", width: 3.5, height: 0.5, depth: 3.5 },
    { x: -3, y: 30, z: -8, shape: "box", width: 2, height: 0.5, depth: 2, special: "moving",
        startPos: { x: -3, y: 30, z: -8 }, endPos: { x: -3, y: 36, z: -8 } },
    { x: -1, y: 38, z: -6, shape: "box", width: 1, height: 0.5, depth: 1 },
    { x: 2, y: 40, z: -8, shape: "triangle", size: 1, height: 0.5 },
    { x: 5, y: 42, z: -6, shape: "sphere", radius: 0.6, height: 0.5 },
    { x: 6, y: 44, z: -2, shape: "box", width: 1, height: 0.5, depth: 1 },
    { x: 3, y: 46, z: 2, shape: "cylinder", radius: 0.25, length: 9 },
    { x: 3, y: 48, z: 8, shape: "box", width: 2, height: 0.5, depth: 2, special: "moving",
        startPos: { x: -1, y: 48, z: 8 }, endPos: { x: 5, y: 48, z: 8 } },
    { x: 4, y: 51, z: 4, shape: "sphere", radius: 0.5, height: 0.5 },
    { x: 3, y: 53, z: 1, shape: "triangle", size: 1.8, height: 0.5 },
    { x: 0, y: 55, z: 2, shape: "box", width: 0.8, height: 0.5, depth: 0.8 },
    { x: 0, y: 57, z: 4, shape: "box", width: 0.8, height: 0.5, depth: 0.8 },
    { x: 3, y: 58, z: 6, shape: "box", width: 5, height: 0.5, depth: 5 },
];

module.exports = {
    TOWER_HEIGHT, GROUND_AREA, PLAYER_SIZE, PLAYER_SPEED,
    JUMP_VELOCITY, GRAVITY, TERMINAL_VELOCITY, SPAWN_POSITION,
    ground, level,
};
