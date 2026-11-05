# Relay migrations

Plain SQL, one directory per module:

```
migrations/core/0001_init.sql
migrations/auth/0001_init.sql
migrations/hooks/0001_init.sql
migrations/voice/0001_init.sql
```

Rules (spec section 9, WP0 seam; frozen):

- Files are named `NNNN_<name>.sql` and applied in lexical order **per module**. Modules run in this order: `core`,
  `auth`, `hooks`, `voice`.
- Each file runs in **one transaction**. A failing file aborts boot and leaves the database as it was.
- Applied files are recorded in `_migrations(module TEXT, name TEXT, applied_at TEXT, PRIMARY KEY (module, name))`.
  The runner is `src/migrate.ts` (a WP0 seam, already written and tested; WP1 calls `migrate(db)` at boot). It creates
  that table itself, checks the file names and checks the table prefixes inside each transaction. Tests get the same
  runner through `test/helpers/fake-services.ts`.
- Tables are prefixed with their module: `core_`, `auth_`, `hooks_`, `voice_`. A module never touches another
  module's tables except through that module's exported functions.
- Migrations only move forward and are additive (Railway rollback redeploys the previous build against the newer
  schema). Never edit a file that has shipped; add a new one.
- Each module owns its directory: WP1 `core/`, WP2 `auth/`, WP3 `hooks/`, WP4 `voice/`.
