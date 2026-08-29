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
        CREATE TABLE IF NOT EXISTS players (
            player_key TEXT PRIMARY KEY,
            coins INTEGER NOT NULL DEFAULT 0,
            items JSONB NOT NULL DEFAULT '[]'::jsonb,
            wins INTEGER NOT NULL DEFAULT 0,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `)).catch((err) => {
        console.error('Failed to set up tables in Neon:', err.message);
    });
} else {
    console.log('DATABASE_URL not set — coins and wins are kept in memory for this run only');
}

// Without a database the game still works: profiles live in memory and are
// gone on restart, so nothing has to branch on whether Neon is configured.
const memory = new Map();

function blank() {
    return { coins: 0, items: [], wins: 0 };
}

function fromMemory(key) {
    if (!memory.has(key)) memory.set(key, blank());
    return memory.get(key);
}

// Points don't do anything on their own — they're the currency the shop spends.
async function recordWin(secondsLeft) {
    if (!pool) return;
    try {
        await ready;
        await pool.query('INSERT INTO wins (points, seconds_left) VALUES ($1, $2)', [1, secondsLeft]);
    } catch (err) {
        console.error('Failed to record win in Neon:', err.message);
    }
}

async function getProfile(key) {
    if (!key) return blank();
    if (!pool) return { ...fromMemory(key) };
    try {
        await ready;
        const res = await pool.query(
            `INSERT INTO players (player_key) VALUES ($1)
             ON CONFLICT (player_key) DO UPDATE SET player_key = EXCLUDED.player_key
             RETURNING coins, items, wins`,
            [key]
        );
        const row = res.rows[0];
        return { coins: row.coins, items: row.items || [], wins: row.wins };
    } catch (err) {
        console.error('Failed to read player profile:', err.message);
        return { ...fromMemory(key) };
    }
}

async function awardCoins(key, coins) {
    if (!key) return blank();
    if (!pool) {
        const p = fromMemory(key);
        p.coins += coins;
        p.wins += 1;
        return { ...p };
    }
    try {
        await ready;
        const res = await pool.query(
            `INSERT INTO players (player_key, coins, wins) VALUES ($1, $2, 1)
             ON CONFLICT (player_key) DO UPDATE
               SET coins = players.coins + $2, wins = players.wins + 1, updated_at = now()
             RETURNING coins, items, wins`,
            [key, coins]
        );
        const row = res.rows[0];
        return { coins: row.coins, items: row.items || [], wins: row.wins };
    } catch (err) {
        console.error('Failed to award coins:', err.message);
        return getProfile(key);
    }
}

// Charges for an item and grants it in one statement, so two tabs racing each
// other can't buy the same thing twice or spend coins that aren't there. Returns
// null when the purchase didn't happen (too poor, or already owned).
async function buyItem(key, item, price) {
    if (!key) return null;
    if (!pool) {
        const p = fromMemory(key);
        if (p.items.includes(item) || p.coins < price) return null;
        p.coins -= price;
        p.items = p.items.concat([item]);
        return { ...p };
    }
    try {
        await ready;
        const res = await pool.query(
            `UPDATE players
                SET coins = coins - $2,
                    items = items || to_jsonb($3::text),
                    updated_at = now()
              WHERE player_key = $1
                AND coins >= $2
                AND NOT (items ? $3)
              RETURNING coins, items, wins`,
            [key, price, item]
        );
        if (!res.rows.length) return null;
        const row = res.rows[0];
        return { coins: row.coins, items: row.items || [], wins: row.wins };
    } catch (err) {
        console.error('Failed to buy item:', err.message);
        return null;
    }
}

module.exports = { recordWin, getProfile, awardCoins, buyItem };
