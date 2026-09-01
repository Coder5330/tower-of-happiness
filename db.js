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
    `).then(() => pool.query(`
        CREATE TABLE IF NOT EXISTS admin_tokens (
            token TEXT PRIMARY KEY,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `)).catch((err) => {
        console.error('Failed to set up tables in Neon:', err.message);
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

// Lets a browser stay logged in as admin (across reloads and server
// restarts) after it has once typed the real ADMIN_CODE, without ever
// storing or checking the code itself here.
async function saveAdminToken(token) {
    if (!pool) return false;
    try {
        await ready;
        await pool.query('INSERT INTO admin_tokens (token) VALUES ($1) ON CONFLICT DO NOTHING', [token]);
        return true;
    } catch (err) {
        console.error('Failed to save admin token in Neon:', err.message);
        return false;
    }
}

async function isAdminToken(token) {
    if (!pool || typeof token !== 'string' || !token) return false;
    try {
        await ready;
        const result = await pool.query('SELECT 1 FROM admin_tokens WHERE token = $1', [token]);
        return result.rowCount > 0;
    } catch (err) {
        console.error('Failed to check admin token in Neon:', err.message);
        return false;
    }
}

async function revokeAdminToken(token) {
    if (!pool || typeof token !== 'string' || !token) return;
    try {
        await ready;
        await pool.query('DELETE FROM admin_tokens WHERE token = $1', [token]);
    } catch (err) {
        console.error('Failed to revoke admin token in Neon:', err.message);
    }
}

module.exports = { recordWin, saveAdminToken, isAdminToken, revokeAdminToken };
