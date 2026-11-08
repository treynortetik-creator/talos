"""_update_app.py: `talos update --app-repo`: merge an upstream ref into the owner's app branch in a side worktree. Python 3.9, standard library only."""
import os
import subprocess

from _update_common import Stop, rm_tree


def git(repo, *args, **kw):
    return subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "-C", repo] + list(args), capture_output=True, text=True, timeout=120, **kw)


def app_merge(repo, ref, apply):
    """Merge `ref` into the app checkout's branch in a side worktree. A conflict aborts the merge there and stops the update; the
    live checkout is never touched until the merge is clean. Returns a one-line summary."""
    if not os.path.isdir(repo) or git(repo, "rev-parse", "--is-inside-work-tree").stdout.strip() != "true":
        raise Stop("--app-repo %s is not a git checkout" % repo)
    if ref.startswith("-") or git(repo, "rev-parse", "--verify", "--quiet", ref + "^{commit}").returncode != 0:
        raise Stop("the app has no commit %r to merge (fetch it first)" % ref)
    if git(repo, "status", "--porcelain", "--untracked-files=no").stdout.strip():
        raise Stop("the app checkout %s has changes that are not committed; commit or stash them, then run this again. Nothing was changed." % repo)
    head = git(repo, "rev-parse", "HEAD").stdout.strip()
    if git(repo, "merge-base", "--is-ancestor", ref, head).returncode == 0:
        return "the app already has %s; nothing to merge" % ref
    gitdir = git(repo, "rev-parse", "--git-common-dir").stdout.strip()
    wt = os.path.join(os.path.realpath(os.path.join(repo, gitdir)), "talos-update-merge-%d" % os.getpid())
    r = git(repo, "worktree", "add", "--detach", wt, "HEAD")
    if r.returncode != 0:
        raise Stop("could not make a side worktree to try the app merge in: %s" % r.stderr.strip())
    try:
        m = git(wt, "merge", "--no-edit", ref)
        if m.returncode != 0:
            files = [f for f in git(wt, "diff", "--name-only", "--diff-filter=U").stdout.split("\n") if f]
            git(wt, "merge", "--abort")
            if files:
                raise Stop("the app has changes that conflict with %s in: %s. Nothing was changed (the merge was aborted in a side copy, "
                           "your app is as it was). Merge %s into your branch yourself, then run talos update again." % (ref, ", ".join(files), ref))
            raise Stop("merging %s into the app failed: %s. Nothing was changed." % (ref, (m.stderr or m.stdout).strip()[:300]))
        merged = git(wt, "rev-parse", "HEAD").stdout.strip()
    finally:
        git(repo, "worktree", "remove", "--force", wt)
        rm_tree(wt)
        git(repo, "worktree", "prune")
    if not apply:
        return "the app merges %s cleanly (dry run: not applied)" % ref
    ff = git(repo, "merge", "--ff-only", merged)
    if ff.returncode != 0:
        raise Stop("the merge was clean but could not be applied to the app checkout: %s" % (ff.stderr or ff.stdout).strip()[:300])
    return "merged %s into the app branch (%s)" % (ref, merged[:7])
