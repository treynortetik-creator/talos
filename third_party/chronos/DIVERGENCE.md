# Divergence from public Chronos

The vendored copy here adds `bridge_instance` to each entry `chronos api orphans` returns (lib/chronos_runlog.py,
`orphans()`). Public Chronos 0.4.0 does not send it, so the bridge cannot rely on it: when it is missing, the orphan
sweep falls back to the owner the bridge's own sidecar recorded for that run (`schedules-meta.json`, in-flight `instance`).
A run with neither is left to Chronos's stale-claim timeout. Do not resync this copy as part of unrelated changes.
