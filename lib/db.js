const { neon } = require("@neondatabase/serverless");

let client = null;
let schemaReady = null;

function databaseUrl() {
  return (process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.NEON_DATABASE_URL || "").trim();
}

function hasDatabase() {
  return Boolean(databaseUrl());
}

function sql() {
  const url = databaseUrl();
  if (!url) throw new Error("DATABASE_URL is not configured.");
  if (!client) client = neon(url);
  return client;
}

async function ensureSchema() {
  if (!hasDatabase()) return;
  if (!schemaReady) {
    schemaReady = (async () => {
      await sql()`
        CREATE TABLE IF NOT EXISTS aicoo_events (
          slug TEXT PRIMARY KEY,
          data JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql()`
        CREATE TABLE IF NOT EXISTS aicoo_participants (
          id TEXT PRIMARY KEY,
          event_slug TEXT NOT NULL,
          source_post_id TEXT,
          data JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql()`
        CREATE INDEX IF NOT EXISTS aicoo_participants_event_slug_idx
        ON aicoo_participants (event_slug)
      `;
      await sql()`
        CREATE TABLE IF NOT EXISTS aicoo_projects (
          id TEXT PRIMARY KEY,
          event_slug TEXT NOT NULL,
          source_post_id TEXT,
          data JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql()`
        CREATE INDEX IF NOT EXISTS aicoo_projects_event_slug_idx
        ON aicoo_projects (event_slug)
      `;
    })();
  }
  await schemaReady;
}

function createdAt(record) {
  return record.createdAt || new Date().toISOString();
}

async function listEvents() {
  if (!hasDatabase()) return [];
  await ensureSchema();
  const rows = await sql()`
    SELECT data
    FROM aicoo_events
    ORDER BY created_at DESC
  `;
  return rows.map((row) => row.data);
}

async function saveEvent(event) {
  if (!hasDatabase()) return event;
  await ensureSchema();
  await sql()`
    INSERT INTO aicoo_events (slug, data, created_at, updated_at)
    VALUES (${event.slug}, ${JSON.stringify(event)}::jsonb, ${createdAt(event)}, NOW())
    ON CONFLICT (slug) DO UPDATE SET
      data = EXCLUDED.data,
      updated_at = NOW()
  `;
  return event;
}

async function listParticipants(eventSlug) {
  if (!hasDatabase()) return [];
  await ensureSchema();
  const rows = await sql()`
    SELECT data
    FROM aicoo_participants
    WHERE event_slug = ${eventSlug}
    ORDER BY created_at DESC
  `;
  return rows.map((row) => row.data);
}

async function saveParticipant(participant) {
  if (!hasDatabase()) return participant;
  await ensureSchema();
  await sql()`
    INSERT INTO aicoo_participants (id, event_slug, source_post_id, data, created_at, updated_at)
    VALUES (
      ${participant.id},
      ${participant.eventSlug},
      ${participant.sourcePostId || null},
      ${JSON.stringify(participant)}::jsonb,
      ${createdAt(participant)},
      NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      event_slug = EXCLUDED.event_slug,
      source_post_id = EXCLUDED.source_post_id,
      data = EXCLUDED.data,
      updated_at = NOW()
  `;
  return participant;
}

async function listProjects(eventSlug) {
  if (!hasDatabase()) return [];
  await ensureSchema();
  const rows = await sql()`
    SELECT data
    FROM aicoo_projects
    WHERE event_slug = ${eventSlug}
    ORDER BY created_at DESC
  `;
  return rows.map((row) => row.data);
}

async function saveProject(project) {
  if (!hasDatabase()) return project;
  await ensureSchema();
  await sql()`
    INSERT INTO aicoo_projects (id, event_slug, source_post_id, data, created_at, updated_at)
    VALUES (
      ${project.id},
      ${project.eventSlug},
      ${project.sourcePostId || null},
      ${JSON.stringify(project)}::jsonb,
      ${createdAt(project)},
      NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      event_slug = EXCLUDED.event_slug,
      source_post_id = EXCLUDED.source_post_id,
      data = EXCLUDED.data,
      updated_at = NOW()
  `;
  return project;
}

module.exports = {
  hasDatabase,
  listEvents,
  listParticipants,
  listProjects,
  saveEvent,
  saveParticipant,
  saveProject,
};
