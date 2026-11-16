-- Org pages (docs/ORG-PAGES-SPEC.md). A page is a thread's published HTML; its versions are named by the SHA-256 of their
-- bytes and kept as encrypted files under DATA_DIR/pages/<page_id>/<hash>.bin (10 at most per page, the oldest dropped). A
-- share (who, and until when) is stored; nobody but the owner's devices can open a page before viewer sign-in (phase 3).
create table core_pages (
  page_id text primary key,             -- pg_<ULID>, minted at the first publish
  title text not null,
  thread_id text not null,              -- the thread that published it: only it may add versions
  created_at integer not null,          -- ms, the relay's clock
  updated_at integer not null,
  current_hash text not null
);
create index core_pages_updated on core_pages (updated_at);
create table core_page_versions (
  page_id text not null references core_pages (page_id) on delete cascade,
  hash text not null,                   -- sha256 hex of the bytes
  bytes integer not null,
  created_at integer not null,
  primary key (page_id, hash)
);
create table core_page_shares (
  page_id text primary key references core_pages (page_id) on delete cascade,
  scope text not null,                  -- people | org
  emails text not null,                 -- JSON array (people); [] for org
  shared_at integer not null,
  expires_at integer                    -- null = until the owner unshares
);
create index core_page_shares_expires on core_page_shares (expires_at);
