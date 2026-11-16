# install-memory.sh: sourced by the root ./install.sh (never run on its own). A NEW agent's memory, set up with no
# questions: semantic memory search (the kit's --with-memory-search; setup.sh picks the model by this computer's memory) and
# the phone's memory browser for memory/ and wiki/ (talos-app memory init --defaults). An agent that existed before this run
# is never changed by these defaults, and an owner's own memory.json is never replaced.
#
#   --no-memory-search   skips the search default (search stays grep and links; later: bash <agent>/scripts/memory/setup.sh)
#   --no-reranker        skips the reranker model (about 571 MB), which a new install also downloads with search unless the
#                        computer has under 3 GiB of memory (--reranker-auto; later: bash <agent>/scripts/memory/fetch-reranker.sh)
#   TALOS_INSTALL_MEMSEARCH_DEFAULT=off   turns the search default off where nothing may be downloaded (the installer's tests)
#
# It reads install.sh's own variables (ALREADY, UNFINISHED, NO_MEMSEARCH, NO_RERANKER, KIT_ARGS, KARGS, DRY, CLI, AGENT_DIR) and uses its
# plan/say/did helpers.

# Right after the arguments are read, before anything changes: exits 2 on the contradiction.
memsearch_flags_ok() {
  if [ "$NO_MEMSEARCH" = 1 ] && [[ " ${KIT_ARGS[*]-} " == *" --with-memory-search "* ]]; then
    echo "--with-memory-search and --no-memory-search contradict each other; pick one. Nothing was changed." >&2
    exit 2
  fi
  if [ "$NO_RERANKER" = 1 ] && [[ " ${KIT_ARGS[*]-} " == *" --with-reranker "* ]]; then
    echo "--with-reranker and --no-reranker contradict each other; pick one. Nothing was changed." >&2
    exit 2
  fi
  return 0
}

# Step 4, before the kit runs: adds --with-memory-search to the kit's flags for a new agent.
memsearch_default() {
  local asked=0
  [[ " ${KIT_ARGS[*]-} " == *" --with-memory-search "* ]] && asked=1
  [ "$ALREADY" != 1 ] && [ "$UNFINISHED" != 1 ] && [ "$NO_MEMSEARCH" != 1 ] && [ "$asked" = 0 ] \
    && [ "${TALOS_INSTALL_MEMSEARCH_DEFAULT:-on}" != off ] && KARGS+=(--with-memory-search)
  # a new agent that gets search also gets the reranker model, unless the computer is small (the kit checks) or it was refused
  if [ "$ALREADY" != 1 ] && [ "$UNFINISHED" != 1 ] && [ "${TALOS_INSTALL_MEMSEARCH_DEFAULT:-on}" != off ] && [ "$NO_RERANKER" != 1 ] \
     && [[ " ${KIT_ARGS[*]-} " != *" --with-reranker "* ]] \
     && { [[ " ${KARGS[*]-} " == *" --with-memory-search "* ]] || [ "$asked" = 1 ]; }; then
    KARGS+=(--reranker-auto)
  fi
  return 0
}

# Step 5, after the MCP server and the bridge: the phone's memory browser for a new agent. It runs FROM the agent folder with
# no --agent-dir: that is the only form the bridge lets run without a terminal, and only before any conversation (no
# history.sqlite) and with no memory.json yet (on-request-cli.ts). On a computer whose Talos has talked before (a second
# agent), it is refused there and this says how to set it up instead.
memory_browser_step() {
  [ "$ALREADY" = 1 ] && return 0
  local out
  if [ "$DRY" = 1 ]; then
    plan "(cd $AGENT_DIR && talos-app memory init --defaults)   (the phone's memory browser: memory/ and wiki/; an existing memory.json is kept)"
  elif out="$(cd "$AGENT_DIR" && "${CLI[@]}" memory init --defaults 2>&1)"; then
    say "   $out"
    did "set up the phone's memory browser"
  else
    say "   the phone's memory browser is not set up: $out"
    say "   set it up later: talos-app memory init (or ask the agent to)"
  fi
  return 0
}
