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
# It reads install.sh's own variables (ALREADY, UNFINISHED, NO_MEMSEARCH, NO_RERANKER, KIT_ARGS, KARGS, DRY, APPLY, CHRONOS, KIT, CLI, AGENT_DIR) and uses its
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

# Step 2b, called by install.sh after the summary of a carry of a kit 1.x folder (the last write is done, so a search that fails,
# is slow or is killed never leaves the folder half carried or the Undo line unprinted). It repeats kit/install.sh's section
# "6. semantic memory search" and its "Reranker model" block, flag for flag (the twin: keep the words and the order the same;
# kit/install.sh ships to agent folders, so it cannot source this file). Never fails the carry. A plan-only run (no --apply)
# and --dry-run only print. Test hook (not for normal use): TALOS_INSTALL_MEMSEARCH_CMD is run by bash -c with the same
# arguments instead of the folder's setup.sh, so a test downloads nothing.
carry_memsearch_step() {
  local setup="$AGENT_DIR/scripts/memory/setup.sh" data="${XDG_DATA_HOME:-$HOME/.local/share}" rc=0 rr=0
  local add="bash $AGENT_DIR/scripts/memory/setup.sh" rerr="bash $AGENT_DIR/scripts/memory/fetch-reranker.sh"
  local cmd=(bash "$setup") embed=auto a prev="" asked=0 asked_rr=0 do_search=1 do_rr=1 nojob=(--no-job) gate=(--if-enough-memory)
  for a in ${KIT_ARGS[@]+"${KIT_ARGS[@]}"}; do
    [ "$prev" = --embed-model ] && embed="$a"
    [ "$a" = --with-memory-search ] && asked=1
    [ "$a" = --with-reranker ] && asked_rr=1
    prev="$a"
  done
  # Chronos comes with every Mac install (the root installer gives the kit --no-chronos only off macOS or with --no-chronos); --no-jobs is its own
  if [ "$CHRONOS" = 1 ]; then nojob=(); for a in ${KIT_ARGS[@]+"${KIT_ARGS[@]}"}; do [ "$a" = --no-jobs ] && nojob=(--no-job); done; fi
  [ "$asked_rr" = 1 ] && gate=()   # an explicit --with-reranker is never second-guessed
  [ -z "${TALOS_INSTALL_MEMSEARCH_CMD:-}" ] || cmd=(bash -c "$TALOS_INSTALL_MEMSEARCH_CMD" memsearch)
  local plan_only=0; { [ "$APPLY" != 1 ] || [ "$DRY" = 1 ]; } && plan_only=1
  if [ "$plan_only" = 1 ]; then say ""; say "   d) semantic memory search, as a new install gets it (it can fail without failing the carry)"
  else step "Semantic memory search"; fi
  if [ "$NO_MEMSEARCH" = 1 ]; then do_search=0; say "   semantic memory search: off (--no-memory-search). Add it later: $add"
  elif [ "${TALOS_INSTALL_MEMSEARCH_DEFAULT:-on}" = off ] && [ "$asked" != 1 ]; then
    do_search=0; say "   semantic memory search: off (TALOS_INSTALL_MEMSEARCH_DEFAULT=off). Add it later: $add"
  fi
  # the reranker comes with a search (unless the computer is small: the kit checks), or on its own when asked for by name
  { [ "$NO_RERANKER" = 1 ] || { [ "$do_search" != 1 ] && [ "$asked_rr" != 1 ]; }; } && do_rr=0
  [ "$do_search" = 1 ] || [ "$do_rr" = 1 ] || return 0
  if [ "$plan_only" = 1 ]; then
    # plan-only: the folder is not upgraded yet, so its setup.sh is the kit's, which every upgrade puts there
    [ "$do_search" != 1 ] || plan "semantic memory search for this agent: $add (a shared venv about 160 MB and a model about 65-210 MB; the install goes on if it fails)"
    if [ "$do_rr" = 1 ]; then
      plan "the reranker model too (kit/scripts/memory/fetch-reranker.sh --dry-run):"
      bash "$KIT/scripts/memory/fetch-reranker.sh" --dry-run ${gate[@]+"${gate[@]}"} | sed 's/^/      /' || true
    fi
    return 0
  fi
  local mk=1
  if [ "$do_search" = 1 ]; then
    if [ ! -f "$setup" ] && [ -z "${TALOS_INSTALL_MEMSEARCH_CMD:-}" ]; then
      rc=1; say "   semantic memory search: not set up, this folder has no scripts/memory/setup.sh (the kit code could not put it there). Add it later by running upgrade.sh again, then: $add"
    elif [ -f "$AGENT_DIR/.index/memory.db" ] && [ -f "$data/talos/venv/.talos-memory-ok" ]; then
      say "   semantic memory search: already set up for this agent"
    else
      [ -z "${TALOS_INSTALL_MEMSEARCH_CMD:-}" ] || say "   the test hook TALOS_INSTALL_MEMSEARCH_CMD runs instead of scripts/memory/setup.sh (not for normal use)"
      # this agent is meant to have semantic search: talos-app doctor warns until it is set up (apps/bridge/src/doctor-memory.ts)
      { mkdir -p "$AGENT_DIR/.index" && : > "$AGENT_DIR/.index/.wanted"; } 2>/dev/null \
        || say "   note: $AGENT_DIR/.index is not writable, so talos-app doctor cannot remind you if search is not set up. $add"
      "${cmd[@]}" --agent-dir "$AGENT_DIR" --embed-model "$embed" ${nojob[@]+"${nojob[@]}"} || rc=$?
      if [ "$rc" = 3 ]; then
        say "   Semantic search was NOT enabled: it needs Python 3.10+ and this Mac only has Apple's 3.9. The carry itself is fine."
        say "   Run this one command, then add search:"
        say "       brew install uv && $add"
        say "   (no Homebrew: curl -LsSf https://astral.sh/uv/install.sh | sh, open a new terminal, then the setup.sh line above)"
      elif [ "$rc" != 0 ]; then
        say "   Semantic search was NOT enabled (setup.sh exited $rc). The carry itself is fine; search is grep + links."
        say "   Add it later with:  $add"
      else say "   set up semantic memory search"; fi
    fi
  fi
  [ "$do_rr" = 1 ] || return 0
  if [ "$asked_rr" != 1 ] && [ "$rc" != 0 ]; then
    say "   reranker: skipped (semantic search is not set up). Add it later: $add --rerank"; return 0
  fi
  if [ ! -f "$AGENT_DIR/scripts/memory/fetch-reranker.sh" ]; then
    say "   reranker: skipped (this folder has no scripts/memory/fetch-reranker.sh). Add it later: $add --rerank"; return 0
  fi
  # the marker tells the doctor a model was meant to be here (it warns, with the retry command, while the files are missing)
  { mkdir -p "$AGENT_DIR/.index" && : > "$AGENT_DIR/.index/.rerank-wanted"; } 2>/dev/null \
    || say "   note: $AGENT_DIR/.index is not writable, so talos-app doctor cannot remind you if the reranker is missing. $rerr"
  bash "$AGENT_DIR/scripts/memory/fetch-reranker.sh" ${gate[@]+"${gate[@]}"} || rr=$?
  if [ "$rr" = 0 ] && [ -x "$data/talos/venv/bin/python" ]; then
    # time one rerank now, for the speed check that is coming (kept in .index/rerank-time.json)
    "$data/talos/venv/bin/python" "$AGENT_DIR/scripts/memory/mem_rerank.py" --probe "$AGENT_DIR" --force 2>&1 | sed 's/^/   /' || true
  fi
  # the marker means "wanted and not there yet": gone once the model is downloaded (0) or skipped for memory (3)
  if [ "$rr" = 0 ] || [ "$rr" = 3 ]; then rm -f "$AGENT_DIR/.index/.rerank-wanted" 2>/dev/null || true
  else say "   the reranker model was not downloaded; search works without it. Retry: $rerr"; fi
  return 0
}
