# A heartbeat source's command was read from ps, which can show the bare shell (sh) before the exec

The heartbeat runner (since 27b0def8; fixed in 26c55891) recorded a running source's command from ps, which can sample the child between fork and exec and see (sh). The gate caught it as a flaky test under load.
