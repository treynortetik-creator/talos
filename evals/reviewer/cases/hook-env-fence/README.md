# The thread session's permission hook ran in its inherited environment, under a python a thread could pick

Review of 2a379960 (R1-1, landed in f37e129a): the permission hook that answers a thread session's prompts ran in that session's environment and under a python3 a thread could choose, so the thread could run its own code as the hook that approves it.
