# install-js.sh: sourced by the root ./install.sh (never run on its own). How this clone's JS packages are installed and which of
# node and pnpm the prerequisites ask for. TALOS_JS_RUNTIME=bun (the Mac app sets it when the Mac has no pnpm, with its own bundled
# bun on the PATH): the packages come from `bun install --frozen-lockfile` (bun reads pnpm-lock.yaml and installs what it pins) and
# the bridge runs on bun, so neither node nor pnpm is needed. Lifecycle scripts are skipped (bun runs none of its dependencies' by
# default anyway): what pnpm builds is better-sqlite3 (the relay's, not run on a Mac) and esbuild's postinstall (dev builds); the root
# `prepare` only installs git hooks, which would run git. The app's updater (auto-update-apply.sh) makes the same choice.
JS_BUN=0; [ "${TALOS_JS_RUNTIME:-}" = bun ] && JS_BUN=1
if [ "$JS_BUN" = 1 ]; then JS_INSTALL_WORDS="bun install --frozen-lockfile"; js_install() { (cd "$REPO" && TALOS_NO_HOOKS=1 bun install --frozen-lockfile --ignore-scripts); }
else JS_INSTALL_WORDS="pnpm install --frozen-lockfile"; js_install() { (cd "$REPO" && pnpm install --frozen-lockfile --config.confirm-modules-purge=false); }; fi
# the node and pnpm prerequisites (called from step 1, where `check`, `problem` and the version numbers are defined)
check_node_pnpm() {
  if [ "$JS_BUN" = 1 ]; then say "   node and pnpm not needed (TALOS_JS_RUNTIME=bun: packages come from bun install)"; return 0; fi
rc=0; check node "$NODE_NEED" node -p 'process.versions.node' || rc=$?
[ "$rc" = 0 ] || problem "Node $NODE_NEED or newer: $(got $rc). No admin needed: $ADMIN_FREE_NODE."
# pnpm through corepack (a link to corepack's pnpm.js) is not asked its version: asking makes corepack download pnpm into
# ~/.cache, and in this clone it runs the pnpm@$PNPM_NEED that package.json pins anyway. A standalone pnpm is asked.
rc=0; PNPM_LINK=""; command -v pnpm >/dev/null 2>&1 && PNPM_LINK="$(link_end "$(command -v pnpm)")"
case "$PNPM_LINK" in
  *corepack*) say "   found pnpm through corepack: $(command -v pnpm) (this clone pins pnpm@$PNPM_NEED; corepack fetches it on first use)" ;;
  # Asked inside this clone, a pnpm of another version would download the pinned one into HOME (pnpm's version switch, on by
  # default); a dry run must write nothing, and the question is about the pnpm that is installed. The environment form stopped
  # the switch on pnpm 10.33 and 12.15 (checked); the --config. flag form did not. Only this question gets it, never `pnpm install`.
  *)
    VER=""; WHERE="$(command -v pnpm 2>/dev/null || true)"
    [ -z "$WHERE" ] || VER="$(vnum "$(env npm_config_manage_package_manager_versions=false pnpm --version 2>/dev/null || true)")"
    if [ -z "$WHERE" ]; then rc=2
    elif [ -z "$VER" ]; then rc=3
    elif ver_ge "$VER" "$PNPM_NEED"; then found pnpm "$VER" "$WHERE"
    # pnpm 10 turned manage-package-manager-versions on by default (pnpm 9 has it off): from 10.0.0 on, `pnpm install` in this
    # clone switches to the pinned version itself, so an older 10.x passes too. Before 10 the installed pnpm must be $PNPM_NEED.
    elif ver_ge "$VER" 10.0.0; then found pnpm "$VER (installs with the pinned $PNPM_NEED)" "$WHERE"
    else rc=1; fi ;;
esac
[ "$rc" = 0 ] || problem "pnpm $PNPM_NEED or newer: $(got $rc). No admin needed: corepack enable pnpm (corepack comes with Node $NODE_NEED from fnm; this clone pins pnpm@$PNPM_NEED)."
}

# Bun answers --version but runs nothing (a damaged or half-written install): the install would fail much later, at the MCP server
# step, after the agent folder was copied. A trivial script is run first, from an empty folder with an empty home, with the env file and
# the transpiler cache off, so a stray bunfig.toml or .env (here or in the home folder) cannot change the answer and nothing is written
# outside that folder, which is removed. It runs under a time limit that ends the whole process group (a hung bun and its children);
# TALOS_INSTALL_BUN_PROBE_SECS (default 30) shortens it for a test. No network is involved. Called from step 1 when bun was found.
bun_runs_or_problem() {
  local d out rc=0 secs="${TALOS_INSTALL_BUN_PROBE_SECS:-30}" try
  d="$(mktemp -d 2>/dev/null)" || return 0   # no scratch folder: the probe cannot run, which is no reason to refuse bun
  # Only stdout counts (a good bun may warn on stderr). The isolated try swaps HOME for the empty folder; a version-manager shim (asdf,
  # mise) finds no version there and fails, so a try that failed (not by the time limit) is made once more with the real HOME, in the
  # same empty folder and with the same flags: bunfig.toml and .env in the working folder are still not read.
  for try in isolated real; do
    rc=0
    if [ "$try" = isolated ]; then
      out="$(cd "$d" && HOME="$d" XDG_CONFIG_HOME="$d" BUN_INSTALL="$d/.bun" BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 \
        perl -e '$t = shift; $p = fork; if (!$p) { setpgrp(0, 0); exec @ARGV } $SIG{ALRM} = sub { kill "TERM", -$p; sleep 2; kill "KILL", -$p; exit 142 }; alarm $t; waitpid($p, 0); exit($? & 127 ? 128 + ($? & 127) : $? >> 8)' \
        "$secs" bun --no-env-file -e 'console.log("talos-bun-ok")' 2>/dev/null < /dev/null)" || rc=$?
    else
      out="$(cd "$d" && BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 \
        perl -e '$t = shift; $p = fork; if (!$p) { setpgrp(0, 0); exec @ARGV } $SIG{ALRM} = sub { kill "TERM", -$p; sleep 2; kill "KILL", -$p; exit 142 }; alarm $t; waitpid($p, 0); exit($? & 127 ? 128 + ($? & 127) : $? >> 8)' \
        "$secs" bun --no-env-file -e 'console.log("talos-bun-ok")' 2>/dev/null < /dev/null)" || rc=$?
    fi
    if [ "$rc" = 0 ] && [ "$out" = talos-bun-ok ]; then rm -rf "$d"; return 0; fi
    [ "$rc" != 142 ] || break   # it hung: another try would hang too
  done
  rm -rf "$d"
  if [ "$rc" = 142 ]; then problem "Bun ($(command -v bun)) did not finish a one-line script within $secs seconds. Nothing was changed. Reinstall it: curl -fsSL https://bun.sh/install | bash"
  else problem "Bun ($(command -v bun)) answers --version but cannot run a script (it exited $rc). Nothing was changed. Reinstall it: curl -fsSL https://bun.sh/install | bash"; fi
}
