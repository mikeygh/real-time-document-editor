/**
 * Yjs WebSocket Server (port 3002)
 *
 * Custom implementation using y-protocols directly.
 *
 * Handles the Yjs sync protocol over WebSocket:
 *   1. Client connects, server responds with awareness state
 *   2. Client sends syncStep1 (state vector) → server replies syncStep2 (diff)
 *   3. Incremental changes flow as sync updates (broadcast to all other clients)
 *   4. Awareness messages (cursors, presence) are relayed between clients
 *
 * Persistence: PostgreSQL — doc state loaded on first access, saved on change.
 */
import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import pg from "pg";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = Number(process.env.YJS_PORT) || 3002;
const DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/docs";

// ---------------------------------------------------------------------------
// Message types (match y-protocols)
// ---------------------------------------------------------------------------
const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------
const pool = new pg.Pool({ connectionString: DATABASE_URL });

async function loadDocument(docName: string): Promise<Uint8Array | null> {
  const result = await pool.query("SELECT content FROM documents WHERE id = $1", [docName]);
  if (result.rows.length > 0 && result.rows[0]?.content) {
    return new Uint8Array(result.rows[0].content as Buffer);
  }
  return null;
}

async function saveDocument(docName: string, update: Uint8Array) {
  const buffer = Buffer.from(update);
  await pool.query(
    `INSERT INTO documents (id, content, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (id) DO UPDATE SET content = $2, updated_at = NOW()`,
    [docName, buffer]
  );
}

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------
const docs = new Map<string, Y.Doc>();
const docConnections = new Map<string, Set<WebSocket>>();
const awarenessMap = new Map<string, awarenessProtocol.Awareness>();
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();

// ---------------------------------------------------------------------------
// Document lifecycle
// ---------------------------------------------------------------------------
function getOrCreateDoc(docName: string): Y.Doc {
  let doc = docs.get(docName);
  if (doc) return doc;

  doc = new Y.Doc();
  docs.set(docName, doc);

  // Start async load from DB — when it arrives it fires an 'update' event.
  // Since there are no connections yet (we're still in the connection handler),
  // the broadcast will be a no-op. The next client syncStep1 will pick up the state.
  loadDocument(docName).then((content) => {
    if (content && content.length > 0) {
      // Apply with null origin so update handler can skip broadcast
      Y.applyUpdate(doc!, content, null);
      console.log(`  → Loaded  "${docName}" (${content.length} bytes)`);
    } else {
      console.log(`  → New doc "${docName}" (empty)`);
    }
  });

  // Broadcast updates to other clients + debounced persist
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === null) return; // DB load — skip broadcast

    // 1. Broadcast to all OTHER clients in this room
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SYNC);
    encoding.writeVarUint(encoder, 2); // SyncStep.Update
    encoding.writeVarUint8Array(encoder, update);
    const message = encoding.toUint8Array(encoder);
    broadcastToRoom(docName, message, origin as WebSocket);

    // 2. Debounce persist — wait 2s after last change
    const existing = persistTimers.get(docName);
    if (existing) clearTimeout(existing);
    persistTimers.set(
      docName,
      setTimeout(() => {
        persistTimers.delete(docName);
        const state = Y.encodeStateAsUpdate(doc!);
        saveDocument(docName, state);
        console.log(`  → Saved   "${docName}" (${state.length} bytes)`);
      }, 2000)
    );
  });

  return doc;
}

function cleanupDoc(docName: string) {
  const conns = docConnections.get(docName);
  if (conns && conns.size > 0) return;

  // No more connections — persist final state then clean up
  const doc = docs.get(docName);
  if (doc) {
    const timer = persistTimers.get(docName);
    if (timer) clearTimeout(timer);
    persistTimers.delete(docName);

    const state = Y.encodeStateAsUpdate(doc);
    saveDocument(docName, state).then(() => {
      docs.delete(docName);
      docConnections.delete(docName);
      awarenessMap.delete(docName);
      doc.destroy();
      console.log(`  → Closed  "${docName}"`);
    });
  }
}

// ---------------------------------------------------------------------------
// Awareness
// ---------------------------------------------------------------------------
function getOrCreateAwareness(docName: string): awarenessProtocol.Awareness {
  let aw = awarenessMap.get(docName);
  if (aw) return aw;

  const doc = getOrCreateDoc(docName);
  aw = new awarenessProtocol.Awareness(doc);
  awarenessMap.set(docName, aw);

  // Broadcast awareness changes to all clients in the room
  aw.on("update", ({ added, removed, updated }: any, _conn: any) => {
    const changed = [...(added || []), ...(removed || []), ...(updated || [])];
    if (changed.length === 0) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_AWARENESS);
    const awarenessUpdate = awarenessProtocol.encodeAwarenessUpdate(aw, changed);
    encoding.writeVarUint8Array(encoder, awarenessUpdate);
    const message = encoding.toUint8Array(encoder);
    broadcastToRoom(docName, message, null);
  });

  return aw;
}

// ---------------------------------------------------------------------------
// Broadcasting
// ---------------------------------------------------------------------------
function broadcastToRoom(docName: string, message: Uint8Array, exclude: WebSocket | null) {
  const conns = docConnections.get(docName);
  if (!conns) return;
  for (const conn of conns) {
    if (conn !== exclude && conn.readyState === WebSocket.OPEN) {
      conn.send(message);
    }
  }
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------
function handleMessage(ws: WebSocket, data: ArrayBuffer, docName: string) {
  const decoder = decoding.createDecoder(new Uint8Array(data));
  const msgType = decoding.readVarUint(decoder);

  switch (msgType) {
    case MSG_SYNC: {
      const doc = getOrCreateDoc(docName);
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_SYNC);
      // readSyncMessage reads the sync subtype (step1/step2/update) from decoder,
      // processes it, and writes the response to encoder.
      // The 4th arg is `transactionOrigin` — we pass the WebSocket so Yjs tags
      // transactions with the sender. We use this in the update handler to avoid
      // broadcasting back to the sender.
      syncProtocol.readSyncMessage(decoder, encoder, doc, ws);
      const reply = encoding.toUint8Array(encoder);
      // reply.length > 1 means there's a real response (sync step2 for step1)
      if (reply.length > 1) {
        ws.send(reply);
      }
      break;
    }

    case MSG_AWARENESS: {
      const awareness = getOrCreateAwareness(docName);
      // Apply the awareness update received from this client
      awarenessProtocol.applyAwarenessUpdate(
        awareness,
        decoding.readVarUint8Array(decoder),
        ws
      );
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
  const docName = req.url?.slice(1) || "default";
  console.log(`  🔗 Client connected → "${docName}"`);

  // Track this connection
  let conns = docConnections.get(docName);
  if (!conns) {
    conns = new Set();
    docConnections.set(docName, conns);
  }
  conns.add(ws);

  // Ensure document exists (triggers async load from DB if needed)
  getOrCreateDoc(docName);

  // Ensure awareness exists and send current state to the new client
  const awareness = getOrCreateAwareness(docName);
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MSG_AWARENESS);
  const initAwareness = awarenessProtocol.encodeAwarenessUpdate(
    awareness,
    Array.from(awareness.getStates().keys())
  );
  encoding.writeVarUint8Array(encoder, initAwareness);
  ws.send(encoding.toUint8Array(encoder));

  // --- Incoming messages ---
  ws.on("message", (data: ArrayBuffer) => {
    try {
      handleMessage(ws, data, docName);
    } catch (err) {
      console.error(`  ⚠ Error handling message:`, err);
    }
  });

  // --- Disconnect ---
  ws.on("close", () => {
    console.log(`  🔌 Client disconnected from "${docName}"`);
    const conns = docConnections.get(docName);
    if (conns) {
      conns.delete(ws);
      if (conns.size === 0) {
        cleanupDoc(docName);
      }
    }
  });

  ws.on("error", (err) => {
    console.error(`  ⚠ WebSocket error:`, err.message);
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
console.log(`🔄 Yjs sync server running on ws://localhost:${PORT}`);
console.log(`   Connect: ws://localhost:${PORT}/<document-id>`);

// Handle graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n  Shutting down...");
  for (const [name, doc] of docs) {
    const state = Y.encodeStateAsUpdate(doc);
    await saveDocument(name, state);
    console.log(`  → Saved   "${name}" (${state.length} bytes)`);
  }
  process.exit(0);
});

process.on("SIGTERM", () => {
  process.exit(0);
});
