# Setup is not finished.

This file is a placeholder that ships with the kit. It gets **overwritten** in BOOTSTRAP step 2
by the real config. If you are reading this, setup either has not started or was interrupted.

## Do this first, before anything else

1. **Check whether `wiki/_onboarding-progress.md` exists.**
   - **It exists** → setup started and the session died partway. Read it, read `BOOTSTRAP.md`, and
     resume at the first wave whose *answers* are not recorded. Do not start over. Do not send them
     to `START-HERE.md`; they already have a working install.
     🔴 If a wave is marked `done` but its answers are not written down, **re-ask it.** Inventing a
     name or a persona they never chose is far worse than asking one question twice.
   - **It does not exist** → genuine cold start. Read `BOOTSTRAP.md` and begin at step 0.

2. **Never delete this file — replace it.** Step 2 renders `templates/CLAUDE.md.tmpl` over the top.

If this file is inside a subfolder of the folder `claude` was started in, nothing here loads at session
start yet: BOOTSTRAP step 0, item 1, moves the kit up one level. Go there first.

If a human is reading this and has not installed Claude Code yet, they want `START-HERE.md`.
