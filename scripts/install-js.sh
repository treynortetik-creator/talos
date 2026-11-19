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
  *) check pnpm "$PNPM_NEED" pnpm --version || rc=$? ;;
esac
[ "$rc" = 0 ] || problem "pnpm $PNPM_NEED or newer: $(got $rc). No admin needed: corepack enable pnpm (corepack comes with Node $NODE_NEED from fnm; this clone pins pnpm@$PNPM_NEED)."
}
