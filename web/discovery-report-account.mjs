import { redact } from './discovery-report.mjs';
/** Metadata only: never select tokens, vault payloads, app code or tracker values. */
export async function reportAccount(db, user, agent) {
    const owner = (await db.query(`SELECT category FROM mtr_harness.agents WHERE id=$1 AND user_id=$2 AND archived_at IS NULL`, [agent, user])).rows[0];
    // A group assistant must not inherit personal inventory from its owner's account.
    if (!owner || owner.category === 'grupo')
        return { capturedAt: new Date().toISOString(), connections: [], apps: [], trackers: [], hosting: 'unknown', partial: false };
    const connections = (await db.query(`SELECT DISTINCT provider,kind FROM (
        SELECT provider,kind FROM mtr_harness.connections WHERE user_id=$1
        UNION ALL SELECT provider,'oauth' AS kind FROM mtr_harness.oauth_tokens WHERE user_id=$1 AND access_token IS NOT NULL
        UNION ALL SELECT 'google' AS provider,'oauth' AS kind FROM mtr_harness.google_accounts g
          JOIN mtr_harness.agents a ON a.id=$2 AND a.user_id=g.user_id AND a.archived_at IS NULL
          WHERE g.user_id=$1 AND g.access_token IS NOT NULL
          AND (a.google_email IS NOT NULL AND lower(a.google_email)=lower(g.google_email) OR a.google_email IS NULL AND g.is_primary=true)
        ) c ORDER BY provider,kind LIMIT 101`, [user, agent])).rows;
    const apps = (await db.query(`SELECT system,description,status FROM mtr_harness.apps WHERE user_id=$1 AND status<>'deleted' ORDER BY created_at DESC,id LIMIT 101`, [user])).rows;
    const trackers = (await db.query(`SELECT title,kind,unit FROM mtr_harness.trackers WHERE owner_user_id=$1 AND enabled=true ORDER BY created_at DESC,id LIMIT 101`, [user])).rows;
    return {
        capturedAt: new Date().toISOString(),
        connections: connections.slice(0, 100).map(c => ({ provider: redact(c.provider).slice(0, 80), kind: redact(c.kind).slice(0, 40) })),
        apps: apps.slice(0, 100).map(a => ({ name: redact(a.system).slice(0, 160), description: redact(a.description).slice(0, 400), status: redact(a.status).slice(0, 40) })),
        trackers: trackers.slice(0, 100).map(t => ({ title: redact(t.title).slice(0, 160), kind: redact(t.kind).slice(0, 40), unit: redact(t.unit).slice(0, 40) })),
        hosting: process.env.APPS_HOST_SSH && process.env.APPS_HOST_KEY ? 'configured' : 'unavailable',
        partial: connections.length > 100 || apps.length > 100 || trackers.length > 100,
    };
}
