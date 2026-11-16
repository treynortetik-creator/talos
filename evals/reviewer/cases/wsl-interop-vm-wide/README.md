# Each Talos boot took out WSL's .exe interop entry, which is one for the whole VM, so the owner's other distros lost it

isolate-mounts unregistered WSL's .exe binfmt entry at every Talos boot (691284c5). The entry is one for the whole WSL 2 VM, so the owner's other distros (Ubuntu) lost `code .` and explorer.exe until something registered it again. Fixed in 6ba94215 (R4-2): interop is judged by wsl.conf alone and the entry is left alone. Found by Fable's round 4 review with a live check. Not one of the cases the prompt was tuned on.
