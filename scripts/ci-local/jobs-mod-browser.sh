# scripts/ci-local/jobs-mod-browser.sh: the mod and browser jobs. Part of scripts/ci-local.sh, which sources it before any wait (functions and
# fixed values only, unchanged from when they were in ci-local.sh). Not run on its own.
# The mod job runs the real Claude CLI, and a throwaway npm copy of it over the network. It does so only on purpose: CI_MOD_REAL=1,
# which ci-runner.sh sets for a CI run and a hand run sets itself (CI_MOD_REAL=1 scripts/ci-local.sh --jobs mod). Without it, or with
# a version that is not digits.digits.digits or `latest` (an empty one once became `npm exec @anthropic-ai/claude-code@`), it refuses
# before it touches claude or npm, and the job is red with that line: a probe or a test that reaches it never reaches them.
claude_at() { # claude_at <version> <args...>: the local CLI when it is that version, else a throwaway npm copy
  local v="$1"; shift
  [ "${CI_MOD_REAL:-}" = 1 ] || { echo "claude_at: refused: the mod job runs the real claude and npm only with CI_MOD_REAL=1 (a CI run sets it; by hand: CI_MOD_REAL=1 scripts/ci-local.sh --jobs mod)"; return 1; }
  [[ "$v" == latest || "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "claude_at: refused: the Claude Code version is '$v', not digits.digits.digits or latest (plugins/talos-app-mod/CLAUDE_CODE_VERSION)"; return 1; }
  local home; home="$(mktemp -d)"
  if [ "$v" != latest ] && [ "$(claude --version 2>/dev/null | cut -d' ' -f1)" = "$v" ]; then
    HOME="$home" claude "$@"
  else
    # npm cache per slot: two `npm exec` installs into one cache's _npx folder at once can clobber each other
    HOME="$home" npm_config_cache="$CACHE/npm-s$CI_SLOT" npm exec --yes --package="@anthropic-ai/claude-code@$v" -- claude "$@"
  fi
}

job_mod() {
  local log="$1" v
  v="$(tr -d '[:space:]' < plugins/talos-app-mod/CLAUDE_CODE_VERSION)"
  run "$log" claude_at "$v" plugin validate plugins/talos-app-mod || { not_run "$log" "claude plugin validate failed" "claude plugin test"; return 1; }
  run "$log" claude_at "$v" plugin test plugins/talos-app-mod || return 1
  if [ "$LATEST" = 1 ]; then
    { run "$log" claude_at latest plugin validate plugins/talos-app-mod && run "$log" claude_at latest plugin test plugins/talos-app-mod; } \
      || echo "(advisory) latest CLI failed; not counted" >> "$log"
  fi
}

# The browser job's tests talk to localhost only. A proxy put in front of it (web protection software on the CI Mac once answered
# page.goto with ERR_UNEXPECTED_PROXY_AUTH) is taken out of the tests' environment, and localhost is never proxied. That reaches
# Node and the tools that read these variables. The browsers on macOS take their proxy from the system settings instead: the
# Playwright configs start Chromium with --no-proxy-server under ci-local; WebKit takes no Chromium flag, so nothing here covers it.
ci_browser_env() {
  unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
  export NO_PROXY=localhost,127.0.0.1 no_proxy=localhost,127.0.0.1
}
# The browser install. `playwright install` first runs a cleanup of the shared cache that reads the browsers.json of every project
# that ever used it (.links), and one of those links pointed into ~/Desktop, where a read blocks for ever in the kernel (0% CPU, no
# output, __dirlock held): twice it held the CI turn for 20-30 minutes. So: nothing is installed when every build is already there;
# an install runs with the cleanup off (PLAYWRIGHT_SKIP_BROWSER_GC) and in a group that is stopped at CI_PW_INSTALL_LIMIT (300 s);
# and a __dirlock older than that, with no install running, is cleared. The limit is a perl in front, as ci_git_net has: only
# the group it made is stopped (TERM, then KILL after 5 s), never a process by name.
PW_GROUP_LIMIT='$t=shift; $p=fork; if(!$p){setpgrp(0,0); exec @ARGV} $SIG{ALRM}=sub{kill "TERM",-$p; sleep 5; kill "KILL",-$p; exit 142}; alarm $t; waitpid($p,0); exit($? & 127 ? 128+($? & 127) : $? >> 8)'
pw_locations() { # the build folders `playwright install chromium webkit` would fill, as Playwright itself says (--dry-run: no lock, no cleanup)
  perl -e "$PW_GROUP_LIMIT" 60 pnpm exec playwright install --dry-run chromium webkit < /dev/null 2>/dev/null | sed -n 's/^ *Install location: *//p'
}
pw_builds_ready() { # every one of those folders has Playwright's own complete marker; no folder named at all is not ready
  local dir n=0
  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    [ -f "$dir/INSTALLATION_COMPLETE" ] || return 1
    n=$((n + 1))
  done < <(pw_locations)
  [ "$n" -gt 0 ]
}
pw_install() { # run holding the playwright-install mutex
  local lim="${CI_PW_INSTALL_LIMIT:-300}" dir lock rc
  case "$lim" in '' | *[!0-9]* | 0) lim=300 ;; esac
  dir="$(pw_locations | head -1)"
  lock="$(dirname "$dir")/__dirlock"
  if [ -n "$dir" ] && [ -e "$lock" ] \
    && perl -e 'my @s = stat($ARGV[0]) or exit 1; exit(time - $s[9] > $ARGV[1] ? 0 : 1)' "$lock" "$lim" \
    && ! grep -Eq '(playwright[^ ]*|cli\.js) install( |$)' <<< "$(ps -Ao command)"; then # not ps | grep -q: pipefail and its SIGPIPE
    echo "ci-local: stale __dirlock ($lock), older than ${lim}s with no playwright install running: removed"
    rmdir "$lock" 2>/dev/null || rm -rf "$lock"
  fi
  PLAYWRIGHT_SKIP_BROWSER_GC=1 perl -e "$PW_GROUP_LIMIT" "$lim" pnpm exec playwright install chromium webkit < /dev/null
  rc=$?
  [ "$rc" != 142 ] || echo "ci-local: playwright install stopped after ${lim}s with no end (a hung read of the shared cache? CI_PW_INSTALL_LIMIT is the limit); its process group was stopped"
  return $rc
}
browser_ready() { # browser_ready <log>: the browsers installed, the proxy gone, the suites told not to build (both browser jobs)
  # E2E_SKIP_BUILD and SKIP_BUILD: setup already built what they serve. The e2e config reads E2E_WORKERS.
  { run "$1" pw_builds_ready && echo "playwright install skipped: every build is already in the shared cache" >> "$1" ||
    run "$1" ci_mutex "$LOCKS" playwright-install pw_install; } && # one shared browser cache
  ci_browser_env && # after the install, which may need a proxy to download a browser
  export SKIP_BUILD=1 E2E_SKIP_BUILD=1 E2E_WORKERS="${E2E_WORKERS:-$(ci_e2e_workers "$CI_CPUS" "${CI_MEM_GB:-0}")}"
}
# The @mac-only tests (docs/CI-MACHINES.md, "browser in two places"): a Playwright tag for what only holds on a Mac. The web
# package runs in full on Lemnos's Mac, tagged tests included; the browser-e2e part (below) refuses any tagged test outside web.
# The flags go after the script name with no `--`: pnpm 10 hands them to Playwright then, and with `--` Playwright gets a `--`
# and drops the filter (measured on Titan, 2026-11-13).
MAC_ONLY_TAG=@mac-only
# The e2e packages on another machine (CI_BROWSER_E2E_PART, docs/CI-MACHINES.md, "The e2e packages on Titan"): this job runs the
# web package's e2e and that machine every other one (job_browser-e2e), split by the same pnpm filter both ways, so a new e2e
# package lands on that side without anyone listing it. The other side leaves out the workspace root too ('!{.}', by path): a
# filter of exclusions alone selects the root, and the root's own test:e2e is `pnpm -r … test:e2e`, every package, web included
# (measured on Titan: the part listed web's @mac-only tests as its own). scripts/ci-local-browser-e2e.test.ts checks the split
# with the real pnpm: every package on exactly one side, never the root. '{.}' is a path relative to the working directory: every
# command using these arrays runs from the worktree's top (none of these jobs cd).
E2E_HERE=(--filter @talos-app/web) E2E_THERE=(--filter '!@talos-app/web' --filter '!{.}')
browser_e2e_fold() { # browser_e2e_fold <log>: the part's answer (its state from the main shell), or its packages taken back here
  # Marks that the main shell may start reading the part (until then it does not spend the rate limit on it, e2e-part-asked).
  local log="$1" m="$CI_BROWSER_E2E_PART" deadline=0 first st why now prev
  : > "$RESULTS/e2e-part-asked"
  ci_fold_wait "$RESULTS" browser # waiting for the part on another machine: no heavy step of this job until it is taken back (turn.sh)
  # The wait counts from the main shell's first reading of the part (up to 60 s, or two of its polls if longer, for that), so a
  # short wait still sees an answer that is already there.
  local poll="${CI_PART_POLL:-30}"
  poll="${poll%.*}"
  first=$(($(date +%s) + (2 * ${poll:-0} > 60 ? 2 * ${poll:-0} : 60)))
  prev=$(date +%s)
  while :; do
    st="$(cat "$RESULTS/e2e-part-state" 2>/dev/null)"
    now=$(date +%s)
    case "$st" in queued*) [ "$deadline" = 0 ] || deadline=$((deadline + now - prev)) ;; esac # queued for a lock on its machine: not counted
    prev=$now
    if [ "$deadline" = 0 ] && { [ -n "$st" ] || [ "$(date +%s)" -ge "$first" ]; }; then
      deadline=$(($(date +%s) + 10#$CI_BROWSER_E2E_WAIT))
    fi
    case "$st" in
      pass) ci_fold_end "$RESULTS" browser; echo "e2e packages on $m" > "$RESULTS/browser.where"; echo "the e2e packages passed on $m (ci-part/browser-e2e)" >> "$log"; return 0 ;;
      fail) ci_fold_end "$RESULTS" browser; echo "the browser-e2e part failed on $m; see its run" > "$RESULTS/browser.e2e-why"; return 1 ;;
      gone) why="its job ended without an answer, or it refused"; break ;; # no point waiting
      stuck*) why="$(part_stuck_why "$st" "$m")"; break ;; # waits for a lock on its machine past CI_PART_LOCK_WAIT_MAX (jobs-check.sh)
    esac
    [ "$deadline" = 0 ] || [ "$now" -lt "$deadline" ] || { why="no answer within ${CI_BROWSER_E2E_WAIT}s${st:+ ($st)}"; break; }
    sleep 1
  done
  # Taken back: the packages run here, and this run's result is browser's. A green the part posts later does not undo a red here
  # (a red here is a test that failed on this machine); a red it posts before browser is posted still fails browser (report).
  ci_fold_resume "$RESULTS" browser "$LOCKS" # heavy work again: the turn first (waits while a gate holds the machine)
  echo "ci-local: taking the e2e packages back from $m: $why" >> "$log"
  echo "e2e packages here: $m did not answer" > "$RESULTS/browser.where"
  run "$log" pnpm -r --workspace-concurrency=1 --no-bail --if-present "${E2E_THERE[@]}" test:e2e
}
BROWSER_STEPS="test:browser test:e2e" # for the NOT RUN lines of a browser job that could not start them
job_browser() {
  local log="$1" only=()
  [ -z "${CI_BROWSER_E2E_PART:-}" ] || only=("${E2E_HERE[@]}")
  # CI_BROWSER_E2E_SHADOW (Lemnos in e2e-shadow, docs/CI-MACHINES.md, "The e2e packages on Titan"): every package here, as today,
  # web first and the others in a call of their own, so the shadow comparison (ci-runner.sh e2e-shadow) reads when web ended
  # and the others' own result from the "e2e-shadow:" lines. With the part, the fold wins: those packages are the part's. Never in
  # the hostile nightly (CI_HOSTILE=1): Titan's copy there is report-only and nothing compares it, so the packages run in one call.
  local shadow=""
  [ -z "${CI_BROWSER_E2E_SHADOW:-}" ] || [ -n "${CI_BROWSER_E2E_PART:-}" ] || [ "${CI_HOSTILE:-}" = 1 ] || { shadow=1 only=("${E2E_HERE[@]}"); }
  # PW_PORT is this slot's own web preview port (exported above), so neither a builder's ad-hoc Playwright run on the
  # default 4173 nor a run in another slot can collide with it. The e2e suite and the relay specs pick free ports.
  # After the check job, not beside it: the e2e suite has the same 3-second waits on real processes, and the web specs want the
  # CPU. That costs the most time of anything in this script, and every overlap tried failed on some run (docs/CI-LOCAL.md).
  setup_ok "$log" $BROWSER_STEPS &&
  job_tmp browser &&
  # (with check on Titan, CI_CHECK_PART, only the macOS-only subset runs here: browser goes when it ends, as desktop does, and
  # does not wait for the part's answer)
  { if [ -n "${CI_CHECK_PART:-}" ]; then wait_for_job check quiet-done; else wait_for_job check; fi; } &&
  { browser_ready "$log" || { not_run "$log" "the browsers could not be made ready" $BROWSER_STEPS; false; }; } &&
  {
    # One failing part never hides the next: the protocol browser suite, then every e2e package (--no-bail, so a web
    # failure does not stop the relay or e2e package after it). The job fails if any part did.
    local other=0 e2e=0 here=0
    run "$log" pnpm test:browser || other=1
    run "$log" pnpm -r --workspace-concurrency=1 --no-bail --if-present ${only[@]+"${only[@]}"} test:e2e || { e2e=1; here=1; }
    [ -z "${CI_BROWSER_E2E_PART:-}" ] || browser_e2e_fold "$log" || e2e=1
    if [ -n "$shadow" ]; then
      local rc=0
      echo "e2e-shadow: web ended at $(date +%s)" >> "$log"
      run "$log" pnpm -r --workspace-concurrency=1 --no-bail --if-present "${E2E_THERE[@]}" test:e2e || { rc=$?; e2e=1; }
      echo "e2e-shadow: the other e2e packages ended with exit $rc" >> "$log"
    fi
    # the part's own red, named, when nothing here failed first
    [ ! -s "$RESULTS/browser.e2e-why" ] || [ "$other$here" != 00 ] || cp "$RESULTS/browser.e2e-why" "$RESULTS/browser.why"
    [ "$other$e2e" = 00 ]
  }
}
# The browser-e2e part (CI_TITAN_BROWSER=e2e: Titan, posted as ci-part/browser-e2e, or report-ci/ in shadow): every e2e package
# but the web one, on CI_PART_E2E_WORKERS workers. It starts with the run (it needs no check). @mac-only tests belong to the
# web package: one in these packages could run nowhere on Linux, so the part does not run then. A part that could not run its
# tests (setup, browsers, the listing, a tagged test) says "not tested" (an error): the browser job takes the packages back.
# Its tests run without --grep-invert: the count above is the only guard, so a count read wrong runs a tagged test here and
# goes red, never green without it.
browser_e2e_untested() { # browser_e2e_untested <log> <why>
  echo "not tested: $2" | tee -a "$1" > "$RESULTS/browser-e2e.refused"
  return 1
}
job_browser-e2e() {
  local log="$1" list n
  [ -z "${CI_PART_E2E_WORKERS:-}" ] || export E2E_WORKERS="$CI_PART_E2E_WORKERS"
  setup_ok "$log" || { browser_e2e_untested "$log" "setup failed on $WHERE ($SETUP_FAILED)"; return 1; }
  job_tmp browser-e2e && browser_ready "$log" || { browser_e2e_untested "$log" "the browsers could not be made ready on $WHERE"; return 1; }
  # `playwright install` exits 0 when the host lacks the browsers' system libraries, and every test then fails at launch: a
  # red that no test made (Titan's first shadow run, before `playwright install-deps` in talos-ci). The job's log is new each run.
  # The words are Playwright's (1.64): re-check them when Playwright is bumped. If they change, a host without the libraries
  # goes back to failing red at launch, never green. The same red, not this refusal, follows a library removed after a good
  # check: Playwright re-checks a browser's host only every 30 days (its DEPENDENCIES_VALIDATED marker).
  if grep -q 'Host system is missing dependencies to run browsers' "$log"; then
    browser_e2e_untested "$log" "the browsers' system libraries are missing on $WHERE (playwright install-deps chromium webkit, as root)"
    return 1
  fi
  list="$TMPDIR/mac-only-e2e"
  if ! pnpm -r --workspace-concurrency=1 --if-present "${E2E_THERE[@]}" test:e2e --list --grep "$MAC_ONLY_TAG" --pass-with-no-tests > "$list" 2>&1; then
    cat "$list" >> "$log"
    browser_e2e_untested "$log" "the $MAC_ONLY_TAG tests of the e2e packages could not be listed on $WHERE"
    return 1
  fi
  n="$(grep -cE '^[[:space:]]+(\[[^]]+\] › )?.+:[0-9]+:[0-9]+ › ' "$list")"
  if [ "$n" != 0 ]; then
    cat "$list" >> "$log"
    browser_e2e_untested "$log" "$n $MAC_ONLY_TAG test lines outside the web package; this part runs on Linux and they would run nowhere"
    return 1
  fi
  echo "E2E_WORKERS=$E2E_WORKERS" >> "$log"
  # under the heavy lock (the suites mutex, and the flock shared across Titan's WSL distros when CI_SHARED_LOCK is set), so a
  # whole-suite run another machine asked Titan for never runs beside it, and neither slows the other. The lock not had in time
  # ran no test: not tested (the browser job takes the packages back), never a red.
  rm -f "$RESULTS/browser-e2e.started"
  BROWSER_E2E_ASKED=$(date +%s)
  run "$log" ci_mutex "$LOCKS" suites browser_e2e_tests && return 0
  [ -f "$RESULTS/browser-e2e.started" ] && return 1
  browser_e2e_untested "$log" "the heavy lock was not had in time on $WHERE"
}
browser_e2e_tests() { # under the lock: mark that the tests started, say how long the lock took (0 too), then run them
  : > "$RESULTS/browser-e2e.started"
  # one line in every part's log, wait or not, so the shadow comparison tells the tests' own time from the wait
  echo "browser-e2e: lock wait $(($(date +%s) - ${BROWSER_E2E_ASKED:-$(date +%s)}))s"
  pnpm -r --workspace-concurrency=1 --no-bail --if-present "${E2E_THERE[@]}" test:e2e
}
