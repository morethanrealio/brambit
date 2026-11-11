// Test contacts: the people who try an assistant out (the owner's team, the client's).
// Their conversations stay on the owner's screen, but the metrics leave them out: the
// volume, the events and the plugin's cards, the click total and the events
// spreadsheet. The owner or an area admin keeps the list, per assistant; an entry is an
// e-mail or a phone number. A contact is a test one when its WhatsApp number is listed
// or when one of its notes holds a listed value (an e-mail a plugin recorded).
//
// Addresses and notes are encrypted, so the SQL cannot compare them: each contact
// carries a flag (public_contacts.is_test). Saving the list sets it on every contact of
// the assistant, past ones included; a new WhatsApp contact or a new note sets it then,
// by the entries' blind index (test_hashes). The list itself is stored encrypted.
import { encMaybe, decMaybe, indiceCego } from '../../vault.mjs';

export const TEST_CONTACTS_PATH = '/api/public-support/test-contacts';
export const TEST_CONTACTS_MAX = 200;
const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const PHONE = /^\+?[\d\s().-]+$/;
const testHash = (entry) => indiceCego(entry, 'public-test-contact');

// An entry as it is kept and compared: an e-mail in lower case, a phone number as its
// 8 to 15 digits; null when it is neither.
export function normalizeTestContact(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s || s.length > 254) return null;
  if (PHONE.test(s)) {
    const digits = s.replace(/\D/g, '');
    return digits.length >= 8 && digits.length <= 15 ? digits : null;
  }
  return EMAIL.test(s) ? s : null;
}

// Inside esquemaPublico, after public_contacts.
export const testContactsSchema = (S) => `
 ALTER TABLE ${S}.public_agents ADD COLUMN IF NOT EXISTS test_contacts text;
 ALTER TABLE ${S}.public_agents ADD COLUMN IF NOT EXISTS test_hashes text[] NOT NULL DEFAULT '{}';
 ALTER TABLE ${S}.public_contacts ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;
 CREATE INDEX IF NOT EXISTS public_contacts_test_idx ON ${S}.public_contacts(agent_id) WHERE is_test;
`;

// Marks the contact as a test one when `value` (its WhatsApp number or a note it just
// got) is on its assistant's list. q = the pool or a transaction's client.
export async function markIfTest(q, S, contactId, value) {
  const entry = normalizeTestContact(value);
  if (!entry) return;
  await q.query(`UPDATE ${S}.public_contacts c SET is_test = true FROM ${S}.public_agents p
    WHERE c.id = $1 AND p.agent_id = c.agent_id AND NOT c.is_test AND $2 = ANY(p.test_hashes)`, [contactId, testHash(entry)]);
}

export function createTestContactsStore(pool, { S = 'mtr_harness' } = {}) {
  const read = (v) => { try { const l = JSON.parse(decMaybe(v) || '[]'); return Array.isArray(l) ? l : []; } catch { return []; } };
  return {
    // The assistant's list, or null when it is not ownerId's (or has no public settings yet).
    async list(agentId, ownerId) {
      const { rows } = await pool.query(`SELECT test_contacts FROM ${S}.public_agents WHERE agent_id = $1 AND user_id = $2`, [agentId, ownerId]);
      return rows.length ? read(rows[0].test_contacts) : null;
    },

    // Replaces the list (entries already normalized) and sets every contact's flag to
    // match it. → {entries, testContacts: how many contacts are test ones}, or null.
    async save(agentId, ownerId, entries) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const { rowCount } = await c.query(`UPDATE ${S}.public_agents SET test_contacts = $3, test_hashes = $4, atualizado_em = now()
          WHERE agent_id = $1 AND user_id = $2`, [agentId, ownerId, encMaybe(JSON.stringify(entries)), entries.map(testHash)]);
        if (!rowCount) { await c.query('ROLLBACK'); return null; }
        const listed = new Set(entries), test = new Set();
        if (listed.size) {
          const { rows: phones } = await c.query(`SELECT id, endereco FROM ${S}.public_contacts WHERE agent_id = $1 AND canal = 'whatsapp'`, [agentId]);
          for (const r of phones) if (listed.has(normalizeTestContact(decMaybe(r.endereco)))) test.add(r.id);
          const { rows: notes } = await c.query(`SELECT s.contact_id, s.valor FROM ${S}.public_contact_state s
            JOIN ${S}.public_contacts k ON k.id = s.contact_id WHERE k.agent_id = $1`, [agentId]);
          for (const r of notes) {
            let v; try { v = decMaybe(r.valor); } catch { continue; }
            if (listed.has(normalizeTestContact(v))) test.add(r.contact_id);
          }
        }
        await c.query(`UPDATE ${S}.public_contacts SET is_test = (id = ANY($2::uuid[]))
          WHERE agent_id = $1 AND is_test <> (id = ANY($2::uuid[]))`, [agentId, [...test]]);
        await c.query('COMMIT');
        return { entries, testContacts: test.size };
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
      finally { c.release(); }
    },
  };
}
