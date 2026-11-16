# A Windows distro script used GNU sed's \U, which BSD sed prints as a literal U

Fable round 1 on 3714c08b, R1-9 (landed in 2ac36e1f): normalize() used sed 's/^./\U&/'. BSD sed has no \U, so on a Mac the drive letter came out as "UC:/" and the distro tests failed there.
