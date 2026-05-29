/**
 * Real-Time Document Editor – Client
 *
 * Architecture:
 *   ┌─────────────────────────────────────────┐
 *   │  TipTap Editor (ProseMirror)            │
 *   │     ↕ y-prosemirror binding             │
 *   │  Y.Doc  (CRDT)                          │
 *   │     ↕ y-websocket provider              │
 *   │  WebSocket → Server (port 3002)         │
 *   └─────────────────────────────────────────┘
 *
 * REST API → Express server (port 3001) for CRUD + presence.
 */

import "./style.css";

import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCursor from "@tiptap/extension-collaboration-cursor";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const API_BASE = "/api";
const WS_BASE = "ws://localhost:3002";

/** Interval (ms) for presence heartbeat */
const HEARTBEAT_INTERVAL = 30_000;

// ---------------------------------------------------------------------------
// User identity (persisted in localStorage)
// ---------------------------------------------------------------------------
interface UserInfo {
  name: string;
  color: string;
}

function getUserInfo(): UserInfo {
  const stored = localStorage.getItem("editor-user");
  if (stored) {
    try {
      return JSON.parse(stored);
    } catch {
      // ignore
    }
  }
  const names = ["Alice", "Bob", "Charlie", "Diana", "Eve", "Frank", "Grace"];
  const colors = [
    "#ff0000", "#00aa00", "#0066ff", "#cc00cc",
    "#ff8800", "#00aaaa", "#aa00aa",
  ];
  const info: UserInfo = {
    name: names[Math.floor(Math.random() * names.length)],
    color: colors[Math.floor(Math.random() * colors.length)],
  };
  localStorage.setItem("editor-user", JSON.stringify(info));
  return info;
}

const currentUser = getUserInfo();

/** Unique session ID (persists for the browser tab lifetime) */
const sessionId = crypto.randomUUID();

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
/** Currently active Y.Doc */
let ydoc: Y.Doc | null = null;
/** Currently active WebSocket provider */
let provider: WebsocketProvider | null = null;
/** Currently active TipTap editor */
let editor: Editor | null = null;
/** Currently open document ID */
let currentDocId: string | null = null;
/** Heartbeat interval handle */
let heartbeatTimer: number | null = null;

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const docListView = $("#doc-list-view")!;
const editorView = $("#editor-view")!;
const docList = $("#doc-list")!;
const docTitle = $("#doc-title") as HTMLInputElement;
const btnBack = $("#btn-back")!;
const btnNewDoc = $("#btn-new-doc")!;
const editorEl = $("#editor")!;
const toolbar = $("#toolbar")!;
const connectionStatus = $("#connection-status")!;
const collabUsers = $("#collab-users")!;

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------
function showListView() {
  editorView.style.display = "none";
  docListView.style.display = "block";
  destroyEditor();
  loadDocList();
}

function showEditorView(docId: string) {
  docListView.style.display = "none";
  editorView.style.display = "block";
  currentDocId = docId;
  initEditor(docId);
}

// ---------------------------------------------------------------------------
// Document List
// ---------------------------------------------------------------------------
interface DocMeta {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

async function loadDocList() {
  try {
    const res = await fetch(`${API_BASE}/documents`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const docs: DocMeta[] = await res.json();
    renderDocList(docs);
  } catch (err) {
    docList.innerHTML = `<div class="error">Failed to load documents: ${err}</div>`;
  }
}

function renderDocList(docs: DocMeta[]) {
  if (docs.length === 0) {
    docList.innerHTML = `<div class="empty-state">No documents yet. Click "New Document" to create one.</div>`;
    return;
  }
  docList.innerHTML = docs
    .map(
      (doc) => `
      <div class="doc-item" data-id="${doc.id}">
        <div class="doc-item-name">${escapeHtml(doc.name)}</div>
        <div class="doc-item-meta">Updated ${formatDate(doc.updated_at)}</div>
      </div>
    `
    )
    .join("");

  // Click handler
  docList.querySelectorAll(".doc-item").forEach((el) => {
    el.addEventListener("click", () => {
      const id = (el as HTMLElement).dataset.id!;
      showEditorView(id);
    });
  });
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------
function initEditor(docId: string) {
  if (editor) destroyEditor();

  // ---- Yjs Document ----
  ydoc = new Y.Doc();

  // ---- WebSocket Provider (connects to Yjs sync server) ----
  provider = new WebsocketProvider(WS_BASE, docId, ydoc, {
    connect: true,
  });

  // Connection status tracking
  provider.on("status", (event: { status: string }) => {
    updateConnectionStatus(event.status);
  });

  // ---- Awareness / Presence ----
  provider.awareness.setLocalStateField("user", currentUser);

  // Update the "who's here" display when awareness changes
  provider.awareness.on("change", () => {
    updateCollabUsers();
  });

  // ---- TipTap Editor ----
  editor = new Editor({
    element: editorEl,
    extensions: [
      StarterKit.configure({
        // Yjs handles history, so disable ProseMirror's built-in undo/redo
        history: false,
      }),
      Collaboration.configure({
        document: ydoc,
        field: "content", // Y.XmlFragment key on the Y.Doc
      }),
      CollaborationCursor.configure({
        provider: provider!,
        user: currentUser,
      }),
    ],
    editorProps: {
      attributes: {
        class: "prose-editor",
      },
    },
  });

  // ---- Toolbar ----
  setupToolbar();

  // ---- Document title ----
  loadDocTitle(docId);

  // ---- Presence heartbeat ----
  startHeartbeat(docId);

  // ---- Back button ----
  btnBack.onclick = showListView;
}

function destroyEditor() {
  stopHeartbeat();
  if (editor) {
    editor.destroy();
    editor = null;
  }
  if (provider) {
    provider.disconnect();
    provider.destroy();
    provider = null;
  }
  if (ydoc) {
    ydoc.destroy();
    ydoc = null;
  }
  currentDocId = null;
  collabUsers.textContent = "";
}

// ---------------------------------------------------------------------------
// Presence heartbeats (via REST API)
// ---------------------------------------------------------------------------
async function sendHeartbeat(docId: string) {
  try {
    await fetch(`${API_BASE}/documents/${docId}/presence`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...currentUser, sessionId }),
    });
  } catch {
    // silently fail — presence is best-effort
  }
}

function startHeartbeat(docId: string) {
  sendHeartbeat(docId);
  heartbeatTimer = window.setInterval(() => sendHeartbeat(docId), HEARTBEAT_INTERVAL);
}

function stopHeartbeat() {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------
function setupToolbar() {
  const actions: Record<string, () => void> = {
    bold: () => editor?.chain().focus().toggleBold().run(),
    italic: () => editor?.chain().focus().toggleItalic().run(),
    heading: () => editor?.chain().focus().toggleHeading({ level: 2 }).run(),
    bulletList: () => editor?.chain().focus().toggleBulletList().run(),
    orderedList: () => editor?.chain().focus().toggleOrderedList().run(),
    undo: () => editor?.chain().focus().undo().run(),
    redo: () => editor?.chain().focus().redo().run(),
  };

  // Remove old listeners by cloning
  const newToolbar = toolbar.cloneNode(true) as HTMLElement;
  toolbar.parentNode?.replaceChild(newToolbar, toolbar);

  newToolbar.querySelectorAll("button[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = (btn as HTMLElement).dataset.action!;
      actions[action]?.();
      // Keep focus on editor
      editor?.commands.focus();
    });
  });
}

// ---------------------------------------------------------------------------
// Connection status
// ---------------------------------------------------------------------------
function updateConnectionStatus(status: string) {
  connectionStatus.className = "status-dot";
  if (status === "connected") {
    connectionStatus.classList.add("connected");
    connectionStatus.title = "Connected";
  } else if (status === "connecting") {
    connectionStatus.classList.add("connecting");
    connectionStatus.title = "Connecting…";
  } else {
    connectionStatus.classList.add("disconnected");
    connectionStatus.title = "Disconnected";
  }
}

// ---------------------------------------------------------------------------
// Collaborative users display
// ---------------------------------------------------------------------------
function updateCollabUsers() {
  if (!provider) return;
  const states = provider.awareness.getStates();
  const others: { name: string; color: string }[] = [];

  states.forEach((state: any, clientId: number) => {
    if (state.user && clientId !== provider!.awareness.clientID) {
      others.push(state.user);
    }
  });

  if (others.length === 0) {
    collabUsers.textContent = "";
    return;
  }

  collabUsers.textContent = others.map((u) => u.name).join(", ");
}

// ---------------------------------------------------------------------------
// Document title
// ---------------------------------------------------------------------------
async function loadDocTitle(docId: string) {
  try {
    const res = await fetch(`${API_BASE}/documents/${docId}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = await res.json();
    docTitle.value = doc.name;
  } catch {
    docTitle.value = "Untitled Document";
  }

  // Save on blur/enter
  const saveTitle = async () => {
    const name = docTitle.value.trim() || "Untitled Document";
    try {
      await fetch(`${API_BASE}/documents/${docId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
    } catch {
      // silently fail
    }
  };

  docTitle.onblur = saveTitle;
  docTitle.onkeydown = (e) => {
    if (e.key === "Enter") {
      docTitle.blur();
    }
  };
}

// ---------------------------------------------------------------------------
// New document
// ---------------------------------------------------------------------------
btnNewDoc.addEventListener("click", async () => {
  try {
    const res = await fetch(`${API_BASE}/documents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Untitled Document" }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = await res.json();
    showEditorView(doc.id);
  } catch (err) {
    alert(`Failed to create document: ${err}`);
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
showListView();
