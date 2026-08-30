const { TOWER_POOL, buildTowerLevel, towerFailures } = require('./towers');

let totalJumps = 0, failedJumps = 0;

for (const meta of TOWER_POOL) {
    const levelData = buildTowerLevel(meta.id);
    const climbable = levelData.slice(4).filter((p) => p.special !== 'kill');
    const failures = towerFailures(levelData);

    totalJumps += Math.max(0, climbable.length - 1);
    failedJumps += failures.length;

    for (const f of failures) {
        if (f.kind === 'ride') {
            console.log(`Tower ${meta.id}: FAILED ride on moving platform near ` +
                `(${f.from.x.toFixed(1)}, ${f.from.y.toFixed(1)}, ${f.from.z.toFixed(1)})`);
        } else {
            const t = f.takeoff;
            console.log(`Tower ${meta.id}: FAILED jump (${t.x.toFixed(1)},${t.y.toFixed(1)},${t.z.toFixed(1)}) -> ` +
                `(${f.to.x.toFixed(1)},${f.to.y.toFixed(1)},${f.to.z.toFixed(1)}) ` +
                `dist=${Math.hypot(f.to.x - t.x, f.to.z - t.z).toFixed(2)} dy=${(f.to.y - t.y).toFixed(2)}`);
        }
    }
    console.log(`Tower ${meta.id}: ${climbable.length} steps, ${failures.length} failed jump(s)`);
}

console.log(`\nTotal: ${totalJumps} jumps simulated, ${failedJumps} failed.`);
process.exit(failedJumps > 0 ? 1 : 0);
