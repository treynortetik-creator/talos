"""_hook_registry.py: the hooks Claude Code will run for an agent folder.

Every kit hook is registered in the agent's own .claude/settings.json (as $CLAUDE_PROJECT_DIR/hooks/<script>), in the plugin
layout too: the plugin registers none, because a folder nobody trusted skips a plugin that only project settings enable.
verify-install.sh and its helper read the hooks through this one function. Python 3.9, standard library only."""
import copy


def merged_hooks(cfg, agent="."):
    return copy.deepcopy(cfg.get("hooks") or {})
