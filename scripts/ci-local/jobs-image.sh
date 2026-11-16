# scripts/ci-local/jobs-image.sh: the image job (Docker). Part of scripts/ci-local.sh, which sources it before any wait (functions and
# fixed values only, unchanged from when they were in ci-local.sh). Not run on its own.
docker_up() {
  docker info >/dev/null 2>&1 && return 0
  if [ "$(uname -s)" = Linux ]; then
    # Linux (Titan, phase B): rootless Docker, the runner user's own service
    command -v systemctl >/dev/null 2>&1 && systemctl --user start docker >/dev/null 2>&1
  elif command -v colima >/dev/null 2>&1; then
    # The marker stays only if this is cut off part way (a cancelled run): ci_end_run then stops the half-started VM.
    [ -z "$RUN_DIR" ] || : > "$RUN_DIR/colima-start"
    # The runner kills every process that carries its job's RUNNER_TRACKING_ID when the job ends (its log: "Terminate orphan
    # process ... (colima)"). The VM's daemon must outlive this run: Docker is the owner's too. So it starts without the id.
    env -u RUNNER_TRACKING_ID colima start >/dev/null 2>&1
    [ -z "$RUN_DIR" ] || rm -f "$RUN_DIR/colima-start"
  fi
  for i in $(seq 1 30); do docker info >/dev/null 2>&1 && return 0; sleep 2; done
  return 1
}

# The image job's checks after /healthz, each a step of its own (its [step] line in the job log names it), each the same check
# as before; a failed one says what came back, so the log tells which one and why (Titan's job failed at one of them, unnamed).
image_root() { # image_root <port>: / serves the web app
  curl -fsS "localhost:$1/" | grep -q '<div id="root">' && return 0
  echo "/ did not serve the web app; it sent (first 200 bytes): $(curl -sS "localhost:$1/" 2>&1 | head -c 200)"
  return 1
}
image_me() { # image_me <port>: /api/me without a session is 401
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' -H 'X-Test-Session: none' "localhost:$1/api/me")"
  [ "$code" = 401 ] && return 0
  echo "/api/me without a session answered $code, not 401"
  return 1
}
image_uid() { # image_uid <container>: the relay runs as uid 10001, not root
  docker exec "$1" sh -c 'grep -q "^Uid:\s*10001" /proc/1/status' && return 0
  echo "the relay does not run as uid 10001: $(docker exec "$1" sh -c 'grep "^Uid:" /proc/1/status' 2>&1)"
  return 1
}
job_image() {
  local log="$1" key port image="talos-relay:ci-$SHORT-s$CI_SLOT"
  printf '%s\n' "$image" > "$RUN_DIR/image" # so a cancel during the build or the run can remove it
  ci_mutex "$LOCKS" docker docker_up >> "$log" 2>&1 || { echo "docker is not running (could not start it)" >> "$log"; return 1; }
  # From the commit, not the worktree: the other jobs are writing into the worktree while this one sends it to Docker.
  run "$log" bash -c 'set -o pipefail; git archive "$1" | docker build -f apps/relay/Dockerfile -t "$2" -' _ "$SHA" "$image" || return 1
  key="$(openssl rand -base64 32)"
  port=$((SLOT_IMAGE_PORT_BASE + RANDOM % 100))
  run "$log" docker run -d --name "$CONTAINER" -p "$port:8080" \
    -e NODE_ENV=production -e PUBLIC_ORIGIN=https://relay.example.com -e RP_ID=relay.example.com \
    -e DATA_KEY="$key" -e VAPID_PUBLIC_KEY=pub -e VAPID_PRIVATE_KEY=priv -e VAPID_SUBJECT=mailto:owner@example.com \
    "$image" || return 1
  for i in $(seq 1 30); do curl -fsS "localhost:$port/healthz" >/dev/null 2>&1 && break; sleep 1; done
  local ok=0
  run "$log" curl -fsS "localhost:$port/healthz" &&
  run "$log" image_root "$port" &&
  run "$log" image_me "$port" &&
  run "$log" image_uid "$CONTAINER" || ok=1
  docker logs "$CONTAINER" >> "$log" 2>&1
  docker rm -f "$CONTAINER" >/dev/null 2>&1
  docker image rm "$image" >/dev/null 2>&1
  return $ok
}
