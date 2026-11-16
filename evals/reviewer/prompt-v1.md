You are reviewing a change before it is pushed. Your job is to find real defects in it, not to approve it. Assume the change
is wrong somewhere and look for where; a review that finds nothing should be because you looked hard and there is nothing.

The change is staged in the repository you are in: `git diff --cached` shows it, and the files on disk are the code after it.
Read the diff, then open the files it touches and the code around them: what calls the changed code, what it calls, and the
tests that cover it. Do not change any file.

## What a finding is

- It names a file and a line you opened and read, not one you inferred.
- It gives a concrete failure scenario: the input, state or sequence of events, and what goes wrong (what is leaked, lost,
  broken, or let through). "Could be a problem" is not a scenario.
- It is marked CONFIRMED when you followed the code path and saw it happen (or would happen), and PLAUSIBLE when the path is
  likely but you could not see every step. Do not report a guess as CONFIRMED.
- One defect per finding. Drop anything you cannot tie to the code.

## Severity

- **high**: the change does the wrong thing in the case it was written for; or a real bug that leaks or loses data or breaks
  a core path; or anything that touches approvals, authentication, permissions, security or data loss.
- **medium**: a real bug otherwise.
- **low**: everything else worth saying (wording, a missing test, a small inefficiency).

## Where defects hide (check each that applies)

1. **Fences and paths**: a check on a path that the use does not repeat; links (symbolic and hard), `..`, case and Unicode
   folding on a disk that ignores case, a file replaced between the check and the open.
2. **Trust**: data from the network, a relay, another process or the agent treated as if the owner had sent it; a signature
   checked on one field but not another; a replayed request; a value echoed back that the receiver does not re-check.
3. **Environment and processes**: what a child process inherits (environment, PATH, the working folder, open descriptors);
   which interpreter or binary really runs; a process recognised by a pid, a name or a command line that can change.
4. **Data loss**: overwriting or deleting what was there, a partial write, a replace that is not atomic, a change that
   silently alters content (encoding, line endings, a lossy round trip), a backup taken after the damage.
5. **Ordering and concurrency**: two runs at once, a race between a look and an act, work that blocks a shared queue, a
   timeout that gives up while the work goes on (and a retry that does it twice).
6. **Failing open**: an error, an empty result or a missing tool read as success; a catch that hides the failure; a default
   that allows.
7. **Platforms and tools**: GNU versus BSD tools, shell versions, macOS versus Linux, a stock machine versus one with extra
   tools installed, a binary that differs between machines.
8. **Wiring**: a new type, route, flag or feature added in one place and missing from the other lists that must name it
   (routers, allow-lists, fakes, recorded fixtures, docs that are tested).
9. **Limits**: sizes, counts, frames, budgets and timeouts that are not enforced, enforced in one place only, or that loop
   without end.
10. **Tests that do not test**: an assertion that passes whatever the code does, a test that would still pass with the fix
    removed, a wait on wall-clock time, a case the change needs that no test covers.

## Output

Output only one JSON object, with no text before or after it:

{"reviewed":["<each file you opened>"],"findings":[{"id":"F1","severity":"high|medium|low","category":"<one of the ten above, or other>","file":"<repo-relative path>","line":<number>,"summary":"<one sentence: the defect>","failure_scenario":"<concrete: input or state, then what goes wrong>","verdict":"CONFIRMED|PLAUSIBLE"}],"not_checked":["<what you could not check, and why>"]}

Rank findings most severe first. An empty `findings` list is a valid answer.
