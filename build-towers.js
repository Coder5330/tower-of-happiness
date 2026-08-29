// Bakes the tower pool into towers.json, so the server starts instantly instead
// of simulating every jump in every tower before it can answer a request.
// Run with: npm run towers   (or: node build-towers.js)
//
// The output is meant to be read and edited by hand — one platform per line —
// so a tower can be tweaked directly. Check any edit with `npm run verify`.
process.env.TOWERS_REBUILD = '1';                 // ignore any existing file

const fs = require('fs');
const path = require('path');
const { TOWER_POOL, SEED_SALT, buildTowerLevel, towerFailures } = require('./towers');

const started = Date.now();
const towers = [];
let failures = 0;

for (const meta of TOWER_POOL) {
    const level = buildTowerLevel(meta.id);
    const bad = towerFailures(level);
    failures += bad.length;
    const climbable = level.slice(4).filter((p) => p.special !== 'kill').length;
    console.log(`Tower ${meta.id}: ${climbable} platforms, ${bad.length} failed jump(s)`);
    towers.push({ id: meta.id, name: meta.name, seed: meta.seed, level });
}

// Hand-written rather than JSON.stringify's indentation: a platform per line
// reads far better than fifteen lines per platform when you're editing one.
const body = towers.map((t) => [
    '    {',
    `      "id": ${t.id},`,
    `      "name": ${JSON.stringify(t.name)},`,
    `      "seed": ${t.seed},`,
    '      "level": [',
    t.level.map((p) => '        ' + JSON.stringify(p)).join(',\n'),
    '      ]',
    '    }',
].join('\n')).join(',\n');

const out = [
    '{',
    `  "seed": ${SEED_SALT},`,
    '  "generatedBy": "build-towers.js",',
    '  "towers": [',
    body,
    '  ]',
    '}',
    '',
].join('\n');

const file = path.join(__dirname, 'towers.json');
fs.writeFileSync(file, out);

const kb = (Buffer.byteLength(out) / 1024).toFixed(0);
console.log(`\nWrote ${towers.length} towers to towers.json (${kb} KB, seed ${SEED_SALT}) ` +
    `in ${((Date.now() - started) / 1000).toFixed(1)}s`);
if (failures) {
    console.error(`${failures} jump(s) failed verification — not shipping this pool`);
    process.exit(1);
}
console.log('Every jump verified.');
