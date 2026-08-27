// Dev-only tool: independently re-simulates every jump in every generated
// tower using the real physics engine, against the tower's final geometry.
// Run with: node verify-towers.js
const { buildObjects } = require('./physics');
const { TOWER_POOL, buildTowerLevel, simulateJump, simulateRide, topY } = require('./towers');

let totalJumps = 0, failedJumps = 0;

for (const meta of TOWER_POOL) {
    const levelData = buildTowerLevel(meta.id);
    const climbable = levelData.slice(4).filter((p) => p.special !== 'kill');

    let towerFailures = 0;
    for (let i = 0; i < climbable.length - 1; i++) {
        const from = climbable[i];
        const to = climbable[i + 1];
        totalJumps++;

        const takeoff = from.special === 'moving' ? { x: from.endPos.x, y: from.y, z: from.endPos.z } : from;

        if (from.special === 'moving') {
            // Fresh build per check — advanceMovingPlatforms mutates moving
            // platforms' moveT in place, so reusing one `objects` across
            // checks would leave later platforms already partway through
            // their travel instead of starting at rest, like the game itself.
            const rode = simulateRide(buildObjects(levelData), from, 260);
            if (!rode) {
                failedJumps++; towerFailures++;
                console.log(`Tower ${meta.id}: FAILED ride on moving platform near (${from.x.toFixed(1)}, ${from.y.toFixed(1)}, ${from.z.toFixed(1)})`);
            }
        }

        const result = simulateJump(buildObjects(levelData), takeoff, to, 200);
        if (!result) {
            failedJumps++; towerFailures++;
            console.log(`Tower ${meta.id}: FAILED jump (${takeoff.x.toFixed(1)},${takeoff.y.toFixed(1)},${takeoff.z.toFixed(1)}) -> (${to.x.toFixed(1)},${to.y.toFixed(1)},${to.z.toFixed(1)}) dist=${Math.hypot(to.x-takeoff.x,to.z-takeoff.z).toFixed(2)} dy=${(to.y-takeoff.y).toFixed(2)}`);
        }
    }
    console.log(`Tower ${meta.id}: ${climbable.length} steps, ${towerFailures} failed jump(s)`);
}

console.log(`\nTotal: ${totalJumps} jumps simulated, ${failedJumps} failed.`);
process.exit(failedJumps > 0 ? 1 : 0);
