#!/usr/bin/env bash
# The old-client step (room decision 4, docs/OLD-CLIENT.md). The web bundle that was live before this change is the page a
# phone may still have cached. .github/workflows/web-bundle.yml saves it at each production deploy. Here this tree's relay
# serves it beside this tree's bridge, and e2e/tests/old-client runs on it. A red means the change would break a phone that
# has not reloaded yet.
#
#   bash scripts/old-client.sh        fetch (or reuse the cached) newest saved bundle and run the specs on it
#   OLD_CLIENT_BUNDLE=<dir>           run on that unpacked web app instead (the save job runs the specs on the new bundle)
#   OLD_CLIENT_STRICT=1               a red fails even with GATING=0 (the save job)
#   OLD_CLIENT_LIMIT=<s>              the time limit for the specs, on their whole process group (default 600)
#
# GATING=1 below (since 2026-11-13; it started advisory, docs/OLD-CLIENT.md): a failing old-client spec fails the step.
# Anything else is never a pass either: no gh, a failed or timed-out listing or download, a tarball that does not match its
# manifest, no saved bundle at all, a relay that does not build, a run that times out or is stopped.
set -uo pipefail

GATING=1

LIMIT="${OLD_CLIENT_LIMIT:-600}"
NET_LIMIT=120
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/talos/web-bundles"
TAG_RE='^web-bundle-[0-9a-f]{8}$'
say() { printf 'old-client: %s\n' "$*" >&2; }
die() {
  say "$*"
  exit 1
}

# limited <seconds> <command...>: the command in a process group of its own; at the limit TERM to the whole group, 5 s later
# KILL; exit 142 when the limit stopped it. The same limiter as scripts/ci-runner.sh's.
limited() {
  perl -MPOSIX=WNOHANG,EINTR -e '
    my $lim = shift;
    my $pid = fork() // die "fork: $!\n";
    if (!$pid) { setpgrp(0, 0); exec @ARGV or die "exec: $!\n" }
    setpgrp($pid, $pid);
    my ($timed, $reaped, $st) = (0, 0, 0);
    my $stop = sub {
      kill "TERM", -$pid;
      for (1 .. 50) {
        if (!$reaped && waitpid($pid, WNOHANG) == $pid) { $reaped = 1; $st = $? }
        last unless kill 0, -$pid;
        select(undef, undef, undef, 0.1);
      }
      kill "KILL", -$pid;
    };
    $SIG{ALRM} = sub { $timed = 1; $stop->() };
    $SIG{$_} = sub { $stop->(); exit 143 } for qw(TERM INT HUP);
    alarm $lim;
    until ($reaped) {
      my $r = waitpid($pid, 0);
      if ($r == $pid) { $reaped = 1; $st = $? } elsif ($r == -1 && $! != EINTR) { last }
    }
    alarm 0;
    kill "KILL", -$pid if kill 0, -$pid;
    exit 142 if $timed;
    exit($st & 127 ? 128 + ($st & 127) : $st >> 8);
  ' "$@"
}

cd "$(git rev-parse --show-toplevel)" || exit 1

bundle="${OLD_CLIENT_BUNDLE:-}"
if [ -z "$bundle" ]; then
  gh_bin="$(command -v gh 2>/dev/null || true)"
  [ -n "$gh_bin" ] || [ ! -x /opt/homebrew/bin/gh ] || gh_bin=/opt/homebrew/bin/gh
  [ -n "$gh_bin" ] || die "no gh here, so the saved web bundle cannot be fetched: install gh and run gh auth login (or set OLD_CLIENT_BUNDLE to an unpacked bundle)"
  # newest by when it was published: a rollback's redeploy is published again and is the live one
  tag="$(limited "$NET_LIMIT" "$gh_bin" release list --limit 50 --json tagName,isPrerelease,isDraft,publishedAt \
    --jq "[.[] | select(.isPrerelease and (.isDraft | not) and (.tagName | test(\"$TAG_RE\")))] | sort_by(.publishedAt) | last | .tagName // \"\"")" ||
    die "could not list the saved web bundles (gh release list failed or took over ${NET_LIMIT} s): check gh auth status and the network"
  if [ -z "$tag" ]; then
    [ "$GATING" = 1 ] && die "no saved web bundle exists (no web-bundle-* prerelease): .github/workflows/web-bundle.yml saves one at each deploy"
    say "ADVISORY: no saved web bundle exists yet (no web-bundle-* prerelease); the first deploy saves one"
    exit 0
  fi
  [[ "$tag" =~ $TAG_RE ]] || die "unexpected release name: $tag"
  dir="$CACHE/$tag"
  if [ ! -f "$dir/manifest.json" ] || [ ! -d "$dir/web" ]; then
    mkdir -p "$CACHE" || die "cannot write $CACHE"
    tmp="$(mktemp -d "$CACHE/tmp.XXXXXX")" || die "cannot write $CACHE"
    trap 'rm -rf "$tmp"' EXIT
    mkdir "$tmp/web"
    limited "$NET_LIMIT" "$gh_bin" release download "$tag" --dir "$tmp" --pattern web-bundle.tar.gz --pattern manifest.json ||
      die "could not download $tag (failed or took over ${NET_LIMIT} s): check gh auth status and the network"
    tar -xzf "$tmp/web-bundle.tar.gz" -C "$tmp/web" --no-same-owner || die "$tag: the tarball does not unpack"
    rm -f "$tmp/web-bundle.tar.gz"
    rm -rf "$dir" && mv "$tmp" "$dir" || die "cannot write $dir"
    trap - EXIT
  fi
  # every run: the files are still the manifest's, and the manifest is this tag's
  node scripts/web-bundle-manifest.mjs verify "$dir/web" "$dir/manifest.json" ||
    die "$tag: the cached files do not match its manifest (rm -rf $dir to fetch it again)"
  node -e 'const m=require(process.argv[1]); process.exit(`web-bundle-${m.sha.slice(0,8)}` === process.argv[2] ? 0 : 1)' \
    "$dir/manifest.json" "$tag" || die "$tag: its manifest is for another commit"
  bundle="$dir/web"
  say "the saved bundle: $tag ($(node -e 'const m=require(process.argv[1]);console.log(`version ${m.version}, deployed ${m.deployed_at}`)' "$dir/manifest.json"))"
fi
[ -f "$bundle/index.html" ] || die "$bundle has no index.html: not a built web app"
bundle="$(cd "$bundle" && pwd)"

# The relay from this tree, built here, so a build failure is never mistaken for an old page that fails.
limited "$LIMIT" pnpm --filter @talos-app/relay build >/dev/null || die "this tree's relay does not build (or took over ${LIMIT} s)"

# The specs, in a process group of their own with a time limit on the whole group.
t=$SECONDS
(cd e2e && export E2E_WEB_DIST="$bundle" E2E_SKIP_BUILD=1 E2E_WORKERS=1 && limited "$LIMIT" pnpm exec playwright test tests/old-client --workers=1)
rc=$?
if [ "$rc" = 0 ]; then
  say "the saved bundle works against this tree ($((SECONDS - t)) s)"
  exit 0
fi
# only a spec that failed (Playwright's 1) is the old page failing; a timeout, a stop or a tool that cannot run is not
[ "$rc" = 142 ] && die "the specs passed their ${LIMIT} s limit and were stopped"
[ "$rc" = 1 ] || die "the specs could not run (exit $rc)"
if [ "$GATING" = 1 ] || [ "${OLD_CLIENT_STRICT:-0}" = 1 ]; then
  say "the saved bundle FAILS against this tree (above): a phone that has not reloaded would break"
  exit 1
fi
say "ADVISORY: the saved bundle fails against this tree (above). Not gating yet (docs/OLD-CLIENT.md), but look before pushing"
exit 0
