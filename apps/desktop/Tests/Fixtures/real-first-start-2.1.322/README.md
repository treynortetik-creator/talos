`tmux capture-pane -p` output of the real Claude Code 2.1.322 on its first start, captured 2026-11-12 on a Linux builder in a
private `-L` tmux server (killed afterwards), pane 150x53. Each run had a temporary `HOME` and `CLAUDE_CONFIG_DIR`, an agent folder
`talos-agent` holding a `.mcp.json` that names `talos-app` and a `.talos-version`, `--plugin-dir` the talos-app mod and
`--dangerously-load-development-channels server:talos-app`, and `ANTHROPIC_BASE_URL` set to a local stand-in that answers `{}`.
Nothing reached a real model or a real sign-in: every run stopped at the first sign-in screen (login method or API-key question)
with nothing pressed there.

- `theme.txt`: no config at all. The theme picker (`Choose the text style that looks best with your terminal`), the cursor on
  `✔ Dark mode`; it has no frame rule and no `Enter to confirm` footer, only a dashed `╌╌╌` row under the list.
- `login-method.txt`: Enter on the theme, no key in the environment. `Select login method:` with `❯ 1. Claude account with
  subscription`. A sign-in screen: never answered.
- `api-key.txt`: Enter on the theme, `ANTHROPIC_API_KEY` set (a fake key). `Detected a custom API key in your environment`,
  `Do you want to use this API key?`, the cursor on `No (recommended)`. Never answered.
- `trust.txt`: onboarding done and the key approved in the scratch config. The folder-trust dialog, cursor on `No, exit`.
  EDITED: the scratch folder's path was replaced by `/home/talos/talos-agent` (the WSL install's folder); nothing else changed.
- `mcp-consent.txt`: after `Yes, I trust this folder`. `New MCP server found in this project: talos-app`, cursor on
  `Continue without using this MCP server`.
- `ready-auto-notice.txt`: after `Use this MCP server`. NOT a dialog: the ready input box under the one-time notice
  `Auto mode is now Claude Code's default permission mode.` Nothing needs answering. (With the scratch MCP server exiting at once,
  no development-channels warning was shown; `real-dev-channels/` holds that one.)

- `token-refused-401.txt`: a separate run with onboarding done, the folder trusted, no plugin or channel flags, and
  `CLAUDE_CODE_OAUTH_TOKEN` set to a fake token; the local stand-in answered every request with a 401
  (`authentication_error`, `Invalid bearer token`). Claude Code shows no sign-in screen with a token set: it starts and comes
  up ready. After `hi` was typed, the answer row is `● Please run /login · API Error: 401 Invalid bearer token` above the ready
  box. Only `POST /v1/messages` was called.
- `security-notes.txt`: a run with `CLAUDE_CODE_OAUTH_TOKEN` set (a fake token) and no config: after Enter on the theme there
  is no login step, but this one: `Security notes:`, two numbered notes, and `Press Enter to continue…` as the last row. No
  cursor, no footer. Enter on it leads to the folder trust, MCP consent and the ready box, as without a token.
- `not-logged-in.txt`: onboarding done, the folder trusted and its MCP server pre-approved in the scratch config, but no
  credentials and no key. Claude Code shows no login screen: it comes up at its input box, starts the project's MCP server,
  and says `Not logged in · Run /login` right-aligned in the row just above the box's top rule. (With no config at all it
  stops on the login method instead, and starts no MCP server.)

Tests use these files as they are. Do not edit them; capture again the same way when Claude Code changes.
