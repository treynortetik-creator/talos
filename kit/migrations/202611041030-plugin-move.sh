#!/usr/bin/env bash
# plugin-move: the kit's Talos zone (hooks, scripts) becomes a Claude Code plugin loaded from a local-folder marketplace.
#
# up:   saves the setup (the Talos app's restore-last-good store when it is reachable, and a .bak next to settings.json),
#       adds the marketplace (extraKnownMarketplaces) and enabledPlugins to .claude/settings.json (the kit's own hook entries stay:
#       they are fixed text that reaches the release through the hooks/ link), moves hooks/ and scripts/ to .talos-pre-plugin/ and
#       puts links to current/talos-kit/ in their place. Every file in the old hooks/ and scripts/ that the release does not ship
#       (the owner's own hooks and scripts, nested folders and dot files included) is copied to custom/hooks/ and custom/scripts/,
#       and the owner's hook commands in settings.json follow. A kit file the owner edited stays in .talos-pre-plugin and is named.
# down: reverses it: links removed, folders moved back, settings.json restored (the original bytes when nothing has edited it
#       since; otherwise only Talos's own changes are undone). custom/ is left in place: a migration deletes nothing outside the zone.
#       Every step can be re-run after a crash. down refuses (and leaves the marker) when there is nothing to move back or when
#       hooks/ or scripts/ is not a real folder at the end.
# Idempotent: a second up finds the layout in place and changes nothing. Touches outside the zone: .claude/settings.json
# (a .bak is kept, a line printed) and the new custom/ folder. memory/, wiki/ and .learnings/ are never touched.

_pm_py() { python3 "$TALOS_RELEASE/scripts/plugin-settings.py" "$@"; }

up() {
  local A="$TALOS_AGENT" R="$TALOS_RELEASE" K="$TALOS_KIT_HOME" pre="$TALOS_AGENT/.talos-pre-plugin" d f rel
  [ -d "$K/current/talos-kit/hooks" ] || { echo "plugin-move: $K/current/talos-kit is not a release; build and activate one first (scripts/plugin-release.py build --activate)" >&2; return 1; }
  # 1. settings.json (saves last-good and a .bak itself, only when it has something to change)
  _pm_py to-plugin --agent "$A" --release "$R" --kit-home "$K" --migration "$TALOS_MIGRATION_ID" || return 1
  # 2. the owner's own files, which must survive the move: every file (nested, dot files too) that the release does not ship
  for d in hooks scripts; do
    [ -d "$A/$d" ] && [ ! -L "$A/$d" ] || continue
    while IFS= read -r -d '' f; do
      rel="${f#"$A/$d"/}"
      if [ ! -e "$R/$d/$rel" ] && [ ! -L "$R/$d/$rel" ]; then
        if [ ! -e "$A/custom/$d/$rel" ] && [ ! -L "$A/custom/$d/$rel" ]; then
          mkdir -p "$(dirname "$A/custom/$d/$rel")" && cp -pP "$f" "$A/custom/$d/$rel" \
            && echo "plugin-move: $d/$rel is yours (the release does not ship it): copied to custom/$d/$rel (outside the Talos zone; the original is kept in .talos-pre-plugin/$d/)"
        elif ! cmp -s "$f" "$A/custom/$d/$rel"; then     # an older copy from an earlier move: keep it, then refresh it
          cp -pP "$A/custom/$d/$rel" "$A/custom/$d/$rel.bak-$TALOS_MIGRATION_ID" \
            && cp -pP "$f" "$A/custom/$d/$rel" \
            && echo "plugin-move: custom/$d/$rel differed from $d/$rel: the old one is kept as custom/$d/$rel.bak-$TALOS_MIGRATION_ID (outside the Talos zone)"
        fi
      elif [ -f "$f" ] && [ -f "$R/$d/$rel" ] && ! cmp -s "$f" "$R/$d/$rel"; then     # a kit file the owner edited: the edit survives in .talos-pre-plugin
        echo "plugin-move: note: $d/$rel differs from this release's copy; yours is kept in .talos-pre-plugin/$d/$rel"
      fi
    done < <(find "$A/$d" -name __pycache__ -prune -o \( -type f -o -type l \) -print0)
  done
  # 3. move the folders aside and link the release in
  local moved=0
  for d in hooks scripts; do
    if [ -L "$A/$d" ]; then
      continue
    elif [ -d "$A/$d" ]; then
      [ ! -e "$pre/$d" ] || { echo "plugin-move: $pre/$d already exists next to a real $d/; move one aside by hand" >&2; return 1; }
      mkdir -p "$pre" && mv "$A/$d" "$pre/$d" || return 1
    elif [ -e "$A/$d" ]; then
      echo "plugin-move: $A/$d is not a folder or a link; left alone" >&2; return 1
    fi
    ln -s "$K/current/talos-kit/$d" "$A/$d" || return 1
    moved=1
  done
  [ "$moved" = 0 ] && echo "plugin-move: hooks/ and scripts/ already link to the release" \
    || echo "plugin-move: hooks/ and scripts/ now link to $K/current/talos-kit/ (the old folders are in .talos-pre-plugin/)"
}

# put the saved folder $pre/$d back as $A/$d. Re-runnable after a crash at any point: the saved folder is moved to a temporary
# name first (one rename, nothing is lost), then the link is swapped for it.
_pm_restore_folder() {
  local d="$1" A="$TALOS_AGENT" pre="$TALOS_AGENT/.talos-pre-plugin" tmp="$TALOS_AGENT/$1.tmp-restore"
  if [ -d "$pre/$d" ] && [ ! -L "$pre/$d" ]; then
    if [ -d "$A/$d" ] && [ ! -L "$A/$d" ]; then
      echo "plugin-move: $A/$d is a real folder and $pre/$d still exists; move one aside by hand, then run down again" >&2; return 1
    fi
    [ ! -e "$tmp" ] || { echo "plugin-move: $tmp is in the way (left by an earlier run); move it aside by hand" >&2; return 1; }
    mv "$pre/$d" "$tmp" || return 1
  fi
  if [ -d "$tmp" ]; then
    if [ -L "$A/$d" ]; then rm "$A/$d" || return 1
    elif [ -e "$A/$d" ]; then echo "plugin-move: $A/$d is not a link and $tmp is waiting; move one aside by hand" >&2; return 1
    fi
    mv "$tmp" "$A/$d" || return 1
  fi
}

down() {
  local A="$TALOS_AGENT" pre="$TALOS_AGENT/.talos-pre-plugin" d nothing=1
  for d in hooks scripts; do
    if [ -d "$pre/$d" ] || [ -d "$A/$d.tmp-restore" ]; then nothing=0; fi
  done
  if [ "$nothing" = 1 ]; then
    if [ -L "$A/hooks" ] || [ -L "$A/scripts" ]; then
      echo "plugin-move: this agent was installed on the plugin layout (there is no .talos-pre-plugin with an older hooks/ and scripts/), so there is nothing to move back; nothing was changed. To leave the plugin layout, copy the release's hooks/ and scripts/ over the links yourself." >&2
      return 1
    fi
  fi
  for d in hooks scripts; do _pm_restore_folder "$d" || return 1; done
  for d in hooks scripts; do
    if [ -L "$A/$d" ] || [ ! -d "$A/$d" ]; then
      echo "plugin-move: $d/ is not a real folder after the restore (is it missing from .talos-pre-plugin/?); the marker was not cleared and settings.json was not touched" >&2
      return 1
    fi
  done
  # custom/ is the owner's now: it is kept (a migration deletes nothing outside the zone), and says so
  [ -d "$A/custom" ] && echo "plugin-move: custom/ was left as it is (copies of your own hooks and scripts); delete it yourself if you do not want it"
  _pm_py from-plugin --agent "$A" --migration "$TALOS_MIGRATION_ID" || return 1
  rm -f "$pre/plugin-move.json"
  rmdir "$pre" 2>/dev/null || true
  echo "plugin-move: back to the layout with hooks/ and scripts/ inside the agent folder"
}
