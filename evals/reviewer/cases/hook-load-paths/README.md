# A thread folder's skill and command files were not checked, a linked .claude was followed, and indented YAML hid keys

Review (4435b8a8): a thread folder's settings were held to an allow-list, but the folder's skill and command files (whose frontmatter can declare hooks) were not checked, a .claude that is a link was followed out of the folder, and keys in indented YAML were not seen.
