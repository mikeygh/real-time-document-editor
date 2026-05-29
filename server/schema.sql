-- Documents table stores Yjs document state as binary blobs
CREATE TABLE IF NOT EXISTS documents (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL DEFAULT 'Untitled Document',
    content     BYTEA,                          -- Yjs encoded document state
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_documents_updated_at ON documents (updated_at DESC);
