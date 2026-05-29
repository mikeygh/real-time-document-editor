# Real-Time Collaborative Document Editor

Built with **TypeScript** + **PostgreSQL** + **Redis** + **Yjs** (CRDT).

```
┌──────────────────────────────────────────────────────────┐
│                    Architecture                          │
│                                                          │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐            │
│  │ Browser  │   │ Browser  │   │ Browser  │            │
│  │ (TipTap  │   │ (TipTap  │   │ (TipTap  │            │
│  │ + Yjs)   │   │ + Yjs)   │   │ + Yjs)   │            │
│  └────┬─────┘   └────┬─────┘   └────┬─────┘            │
│       │              │              │                   │
│       └──────────────┼──────────────┘                   │
│                      │                                  │
│          ┌───────────┴───────────┐                      │
│          │   Yjs Sync Server     │  (port 3002)         │
│          │   (WebSocket + CRDT)  │  y-websocket         │
│          └───────────┬───────────┘                      │
│                      │                                  │
│          ┌───────────┴───────────┐                      │
│          │   REST API Server     │  (port 3001)         │
│          │   (Express)           │  doc CRUD + presence │
│          └───────────┬───────────┘                      │
│                      │                                  │
│             ┌────────┴────────┐                         │
│             │  PostgreSQL     │  Redis                  │
│             │  (persistence)  │  (presence)             │
│             └─────────────────┘                         │
└──────────────────────────────────────────────────────────┘
```

## Features

- **Real-time collaboration** — multiple users edit the same document simultaneously
- **CRDT-based sync** — Yjs ensures all clients converge without conflicts
- **Rich text editing** — TipTap / ProseMirror with bold, italic, headings, bullet lists
- **Collaborative cursors** — see other users' cursors and selections in real time
- **PostgreSQL persistence** — document state is saved and restored across restarts
- **Presence tracking** — see who's currently editing (via Redis heartbeats)
- **Document management** — create, rename, and delete documents

## Prerequisites

- **Node.js** >= 20
- **Docker** (for PostgreSQL and Redis)
- **npm** or **pnpm**

## Quick Start

### 1. Start infrastructure (PostgreSQL + Redis)

```bash
docker compose up -d
# Wait a few seconds for the databases to start
```

### 2. Install dependencies

```bash
npm install
```

### 3. Initialize the database

```bash
# Create the 'docs' database (skip if Docker auto-creates it)
createdb docs 2>/dev/null || true

# Run the schema
npm run db:init
```

### 4. Start the servers

```bash
# Starts all three processes:
#   API server    → http://localhost:3001
#   Yjs server    → ws://localhost:3002
#   Client (Vite) → http://localhost:5173
npm run dev
```

### 5. Open in browser

Open [http://localhost:5173](http://localhost:5173) in **two or more browser windows**.

- Click **"New Document"** to create a document
- Type in one window — changes appear instantly in the other
- Cursors and selections are visible to all users

## Project Structure

```
├── docker-compose.yml      # PostgreSQL + Redis
├── package.json            # Workspace scripts & dependencies
├── tsconfig.json           # TypeScript config
├── README.md
├── server/
│   ├── schema.sql          # DB schema
│   ├── api.ts              # Express REST API (port 3001)
│   └── yjs-server.ts       # Yjs WebSocket server (port 3002)
└── client/
    ├── index.html
    ├── vite.config.ts
    └── src/
        ├── main.ts         # App logic, editor setup, presence
        └── style.css       # Styling
```

## How It Works

### CRDT (Conflict-free Replicated Data Type)

Yjs is a **CRDT library** that allows multiple users to edit the same document simultaneously without a central conflict resolver. Every character has a unique ID `(site, clock)`. Edits are ordered deterministically by these IDs, so all clients converge to the same state regardless of the order in which edits arrive.

### Sync Flow

1. Client A types a character
2. TipTap calls `y-prosemirror` which updates the `Y.Doc`
3. `Y.Doc` emits an update event
4. `y-websocket` provider sends the update to the server
5. Server applies the update to its `Y.Doc` and broadcasts it to all other clients
6. Clients B, C, etc. receive the update and apply it to their `Y.Doc`
7. Their `y-prosemirror` binding updates TipTap, and the character appears

### Persistence

The server's `setPersistence({ bindState, writeState })` hooks into y-websocket:
- **bindState**: loads the Yjs document from PostgreSQL when the first client connects
- **writeState**: saves a snapshot every ~5 seconds while the document is dirty

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/documents` | List all documents |
| POST | `/api/documents` | Create a new document |
| GET | `/api/documents/:id` | Get document metadata |
| PATCH | `/api/documents/:id` | Rename a document |
| DELETE | `/api/documents/:id` | Delete a document |
| POST | `/api/documents/:id/presence` | Presence heartbeat |
| GET | `/api/documents/:id/presence` | List active editors |
| WS | `ws://localhost:3002/:id` | Yjs sync (for client) |

## Future Enhancements

- [ ] **Authentication** — user accounts and login
- [ ] **Permissions** — public/private documents, sharing
- [ ] **Comments** — threaded comments on document
- [ ] **Version history** — time-travel through document revisions
- [ ] **Offline support** — Yjs supports offline edits; sync on reconnect
- [ ] **Rich text improvements** — images, tables, links, code blocks
- [ ] **Drag-and-drop** — file uploads via TipTap extensions
- [ ] **Deployment** — Docker Compose for production, or cloud deployment

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Language | TypeScript |
| Editor | TipTap (ProseMirror) |
| CRDT | Yjs |
| Sync transport | y-websocket (WebSocket) |
| REST API | Express |
| Primary DB | PostgreSQL 16 |
| Ephemeral store | Redis 7 |
| Build tool | Vite |

## Why This Stack?

| Concern | Choice | Why |
|---------|--------|-----|
| **CRDT** | Yjs | Most mature JS CRDT lib. Native TipTap binding. Used by Linear, Obsidian. |
| **Rich text** | TipTap/ProseMirror | Gold standard for web rich text. Built-in Yjs collaboration. |
| **Persistence** | PostgreSQL | Reliable, JSONB for flexibility, LISTEN/NOTIFY for real-time if needed. |
| **Presence** | Redis | Ephemeral TTL-based state. Perfect for "who's online?" with auto-cleanup. |
| **Language** | TypeScript | Same language frontend + backend, largest ecosystem for CRDT/web. |
