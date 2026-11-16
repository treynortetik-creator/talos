# ci-runner.sh's logs step (sourced by it for `logs`; kept apart so ci-runner.sh stays under 1,000 lines).
# shellcheck shell=bash
# ---------- logs ----------
# For the workflow's uploads (the repository's artifact storage is small: a green run uploads only its per-test files):
# CI_TESTS_OUT (when set): this commit's per-test files (<short>-*-tests.tsv, scripts/ci-test-results.ts) and its check log's
# "lock wait" lines (<short>-check-lock-wait.txt), every run. CI_LOGS_OUT: its own logs (<short>-*.log, the <short>-*.log.* step
# logs beside them), those files and timings.tsv, only for a red or not-tested run: a job that is not a success (CI_JOB_STATUS;
# empty is taken as red), or one that posted a failure or an error (ci_post_status's <CI_SHA_FILE>.red). full=true|false goes
# to GITHUB_OUTPUT. The log cache keeps every run ever (hundreds of MB), and uploading all of it held the next run up a minute.
ci_logs() {
  local cache out="${CI_LOGS_OUT:-}" tests="${CI_TESTS_OUT:-}" sha="" f full=false
  [ "${CI_JOB_STATUS:-}" = success ] || full=true
  [ ! -s "${CI_SHA_FILE:-/nonexistent}.red" ] || full=true
  echo "full=$full" >> "${GITHUB_OUTPUT:-/dev/null}"
  [ -n "$out" ] || { echo "ci-runner: CI_LOGS_OUT is not set" >&2; return 1; }
  cache="$(ci_cache_dir)" || return 1
  [ "$full" = false ] || { mkdir -p "$out" && { [ ! -f "$cache/logs/timings.tsv" ] || cp "$cache/logs/timings.tsv" "$out/"; }; } || return 1
  [ -n "${CI_SHA_FILE:-}" ] && [ -s "$CI_SHA_FILE" ] || { echo "ci-runner: no run got as far as a commit; no job logs"; return 0; }
  sha="$(head -1 "$CI_SHA_FILE")"
  case "$sha" in *[!0-9a-f]* | '') echo "ci-runner: $CI_SHA_FILE does not hold a commit sha; no job logs" >&2; return 1 ;; esac
  if [ -n "$tests" ] && mkdir -p "$tests"; then
    for f in "$cache/logs/${sha:0:7}"-*-tests.tsv; do [ ! -f "$f" ] || cp "$f" "$tests/"; done
    [ ! -f "$cache/logs/${sha:0:7}-check.log" ] || grep 'lock wait [0-9]*s' "$cache/logs/${sha:0:7}-check.log" > "$tests/${sha:0:7}-check-lock-wait.txt"
    echo "ci-runner: $(find "$tests" -type f | wc -l | tr -d ' ') per-test file(s) of ${sha:0:7} for upload"
  fi
  [ "$full" = true ] || { echo "ci-runner: a green run: no full logs uploaded"; return 0; }
  for f in "$cache/logs/${sha:0:7}"-*.log "$cache/logs/${sha:0:7}"-*.log.* "$cache/logs/${sha:0:7}"-*.tsv; do
    [ ! -f "$f" ] || cp "$f" "$out/"
  done
  echo "ci-runner: $(find "$out" -type f | wc -l | tr -d ' ') file(s) of ${sha:0:7} for upload"
}
