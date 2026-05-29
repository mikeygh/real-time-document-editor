/**
 * REST API Server (port 3001)
 *
 * Provides document CRUD and presence queries.
 * The Yjs collaboration runs on a separate WebSocket server (port 3002).
 */
import express from "express";
import cors from "cors";
import pg from "pg";
import Redis from "ioredis";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = Number(process.env.API_PORT) || 3001;
const DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/docs";
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------
const pool = new pg.Pool({ connectionString: DATABASE_URL });

// Run migrations on startup
async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS documents (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL DEFAULT 'Untitled Document',
      content    BYTEA,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_documents_updated_at ON documents (updated_at DESC);
  `);
  console.log("  → PostgreSQL migrated");
}

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------
const redis = new Redis(REDIS_URL);
redis.on("error", (err) => console.warn("  ⚠ Redis error:", err.message));

// ---------------------------------------------------------------------------
// Express
// ---------------------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());

// ---- Document CRUD -------------------------------------------------------

/** List all documents (metadata only, no content) */
app.get("/api/documents", async (_req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, name, created_at, updated_at FROM documents ORDER BY updated_at DESC"
    );
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Create a new document */
app.post("/api/documents", async (req, res) => {
  try {
    const id = crypto.randomUUID();
    const name = req.body.name?.trim() || "Untitled Document";
    await pool.query("INSERT INTO documents (id, name) VALUES ($1, $2)", [id, name]);
    res.status(201).json({ id, name });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Get a single document */
app.get("/api/documents/:id", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM documents WHERE id = $1", [
      req.params.id,
    ]);
    if (result.rows.length === 0)
      return res.status(404).json({ error: "Document not found" });
    // Send metadata + content length (not the binary itself — Yjs handles that via WebSocket)
    const doc = result.rows[0];
    res.json({
      id: doc.id,
      name: doc.name,
      contentLength: doc.content ? doc.content.length : 0,
      created_at: doc.created_at,
      updated_at: doc.updated_at,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Rename a document */
app.patch("/api/documents/:id", async (req, res) => {
  try {
    const { name } = req.body;
    if (!name?.trim())
      return res.status(400).json({ error: "Name is required" });
    const result = await pool.query(
      "UPDATE documents SET name = $1, updated_at = NOW() WHERE id = $2 RETURNING id, name, updated_at",
      [name.trim(), req.params.id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: "Document not found" });
    res.json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Delete a document */
app.delete("/api/documents/:id", async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM documents WHERE id = $1 RETURNING id",
      [req.params.id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: "Document not found" });
    // Also clean up Redis presence
    await redis.del(`doc:${req.params.id}:users`);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Presence (heartbeat-based) ------------------------------------------

/**
 * Report that a user is currently editing a document.
 * Client sends a unique sessionId that persists across heartbeats,
 * so the Redis key gets refreshed (not duplicated).
 */
app.post("/api/documents/:id/presence", async (req, res) => {
  try {
    const { sessionId, name, color } = req.body;
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });

    const key = `user:${sessionId}`;
    const userInfo = { name, color, sessionId };

    // Store with 40-second TTL (heartbeat comes every 30s)
    await redis.set(key, JSON.stringify(userInfo), "EX", 40);
    await redis.sadd(`doc:${req.params.id}:users`, sessionId);
    await redis.expire(`doc:${req.params.id}:users`, 40);

    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Get users currently editing a document */
app.get("/api/documents/:id/presence", async (req, res) => {
  try {
    const uids = await redis.smembers(`doc:${req.params.id}:users`);
    const users = await Promise.all(
      uids.map(async (uid) => {
        const data = await redis.get(`user:${uid}`);
        return data ? JSON.parse(data) : null;
      })
    );
    res.json(users.filter(Boolean));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function main() {
  await migrate();
  app.listen(PORT, () => {
    console.log(`📝 API server running on http://localhost:${PORT}`);
    console.log(`   GET    /api/documents           – list documents`);
    console.log(`   POST   /api/documents           – create document`);
    console.log(`   GET    /api/documents/:id       – get document`);
    console.log(`   PATCH  /api/documents/:id       – rename document`);
    console.log(`   DELETE /api/documents/:id       – delete document`);
    console.log(`   GET    /api/documents/:id/presence – list presence`);
    console.log(`   POST   /api/documents/:id/presence – heartbeat`);
  });
}
main();
