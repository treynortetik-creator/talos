# The Windows logon task and the owner's scripts ran from the clone, which a thread can write

Fable round 1 on 3714c08b, R1-1 (landed in 3c4d3509): the logon task and the owner's scripts ran from the clone. A thread session working in the clone can edit those files, so it could make the owner's account run its code at every logon.

The same round found more real bugs in this change, scored here too (`expect_mode: any`): a junction higher up a shared
folder's path (R1-4), a refused folder named another way, by an 8.3 short name or a trailing dot or space (R1-4), the clone's
origin URL with its login copied into the distro (R1-5), and root's setup files staged in /var/tmp (R1-2).
