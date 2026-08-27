const { Pool } = require('pg');

let pool = null;
let ready = null;

if (process.env.DATABASE_URL) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    ready = pool.query(`
        CREATE TABLE IF NOT EXISTS wins (
            id SERIAL PRIMARY KEY,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            points INTEGER NOT NULL DEFAULT 1,
            seconds_left NUMERIC
        )
    `).catch((err) => {
        console.error('Failed to set up "wins" table in Neon:', err.message);
    });
} else {
    console.log('DATABASE_URL not set — wins will not be saved to Neon (game still works normally)');
}

// Points don't do anything yet — this just records that a win happened, for later use.
async function recordWin(secondsLeft) {
    if (!pool) return;
    try {
        await ready;
        await pool.query('INSERT INTO wins (points, seconds_left) VALUES ($1, $2)', [1, secondsLeft]);
    } catch (err) {
        console.error('Failed to record win in Neon:', err.message);
    }
}

module.exports = { recordWin };
