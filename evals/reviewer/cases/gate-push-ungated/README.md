# gate.sh --push stamped the tree after the gate and pushed HEAD, so a commit made while the gate ran went out ungated

Fable on gate.sh --push (fixed before it landed in 52d6b427): the stamp's tree was read after the gate finished and the push sent HEAD, so a commit made in the same worktree while the gate ran went to main ungated, the hook trusting the stamp.
