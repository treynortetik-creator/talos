# Divergence from public Chronos

The vendored copy here differs from public Chronos 0.5.0 in one place. Do not resync this copy as part of unrelated changes.

1. **`bridge_instance` in `chronos api orphans`** (lib/chronos_runlog.py, `orphans()`). Public Chronos 0.5.0 does not send it, so the
   bridge cannot rely on it: when it is missing, the orphan sweep falls back to the owner the bridge's own sidecar recorded for that
   run (`schedules-meta.json`, in-flight `instance`). A run with neither is left to Chronos's stale-claim timeout.
