# Unmounting WSLg mounts before making them private: the unmount propagates through the shared peer group to WSL's own VM

The Talos distro's isolation unmounted WSLg mounts before all of them, parents first, were made private (3c4d3509). They are in a shared peer group that reaches WSL's own VM, so an unmount propagates out: in round 1 a tmpfs on /mnt/wsl stopped every distro on the PC from starting until `wsl --shutdown`. Fixed in 953a5d13 (R2-1): every mount is made private, parents first, before any is unmounted. Not one of the cases the prompt was tuned on.
