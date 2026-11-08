import Foundation

/// What the terminal window's agent tab shows (audit D43). It used to attach only while the supervisor held a live child pid,
/// so after a failed start the window said "No agent session yet" while `tmux ls` listed the session and its dead pane (the
/// last screen, kept by `remain-on-exit`). The owner needs exactly that screen.
public enum TerminalPane {
  public enum Choice: Equatable, Sendable {
    case attach
    case note(String)
  }

  public static func choose(configured: Bool, hasLiveChild: Bool, sessionExists: Bool) -> Choice {
    if hasLiveChild || sessionExists { return .attach }
    return .note(configured ? "No agent session yet. Menu → Start session." : "Talos isn't set up yet. Menu → Setup checklist…")
  }
}

/// One thread session as the terminal window lists it (D48). Built from `workers.json` only; nothing here touches tmux.
public struct ThreadSessionRow: Equatable, Sendable {
  public let threadId: String
  public let tmuxSession: String
  public let cwd: String
  public let sessionId: String?
  /// "Working", "Parked", "Needs attention" ... in the words the app uses.
  public let stateText: String
  /// Why it stopped, or what it is doing, in a sentence.
  public let detail: String
  /// A pane may exist behind this row. Anything but off/parked/failed counts, so a newer copy's unknown state is still attachable.
  public let canAttach: Bool
  public let needsMac: Bool
  /// What the dialog said (the worker manager keeps the screen's label as the error detail). nil unless `needsMac`.
  public let dialogLabel: String?
}

public enum ThreadSessions {
  public static func rows(from file: WorkersFile?) -> [ThreadSessionRow] {
    guard let file else { return [] }
    return file.threads.keys.sorted().compactMap { id in
      guard let e = file.threads[id], WorkerSpec.isThreadId(id) else { return nil }
      let needsMac = e.state == "failed" && e.error?.code == "needs_mac"
      let label = needsMac ? e.error?.detail.flatMap { $0.isEmpty ? nil : $0 } : nil
      return ThreadSessionRow(
        threadId: id, tmuxSession: WorkerSpec.tmuxName(id), cwd: e.cwd, sessionId: e.session_id.flatMap { WorkerSpec.isUUID($0) ? $0 : nil },
        stateText: stateText(e.state), detail: detail(e), canAttach: !WorkersFile.restingStates.contains(e.state),
        needsMac: needsMac, dialogLabel: label)
    }
  }

  public static func stateText(_ state: String) -> String {
    switch state {
    case "off": return "Not started"
    case "starting": return "Starting"
    case "live": return "Live"
    case "busy": return "Working"
    case "parking": return "Parking"
    case "stopping": return "Stopping"
    case "parked": return "Parked"
    case "failed": return "Needs attention"
    default: return "Unknown"
    }
  }

  /// The stop reason in plain words. Same wording as the app's thread-sessions line (apps/web .../thread-sessions/store.ts).
  public static func detail(_ e: WorkersFile.Entry) -> String {
    switch e.state {
    case "failed":
      switch e.error?.code ?? "" {
      case "needs_mac":
        return "It stopped at a question only this Mac can answer. Open claude in its folder below and answer it there, then open this thread's settings in the app and press Restart. A message alone won't start it."
      case "resume_missing": return "Its conversation can't be resumed. Start fresh from the app to begin a new one."
      case "crash_loop": return "It kept crashing, so it was stopped."
      case "start_failed": return "It didn't start."
      case "folder_claimed": return "Another thread session works in that folder."
      case "mode_escalation_denied":
        return "It was not started: it would have more access than the main session (a wider permission mode, more MCP servers or fewer deny rules). Narrow its settings in the app, then press Restart."
      default: return "It stopped and needs attention."
      }
    case "parked": return "Parked to save memory. It starts again with the next message."
    case "off": return "Not started. It starts with the next message."
    case "starting": return "Starting."
    case "live": return "Running and idle."
    case "busy": return "Working on a turn."
    case "parking": return "Finishing its turn, then parking."
    case "stopping": return "Stopping."
    default: return "A state this version doesn't know. It may be running."
    }
  }

  /// What "open claude here" runs for a needs_mac row: interactive `claude` in the thread's folder. It gets the same plugin-off
  /// settings and Talos-home deny a worker gets, so it can never start the Telegram or iMessage plugin (which would take the main agent's bot);
  /// and the worker's permission flag, so the dialog that stopped the worker can come up again. No keystrokes typed for the
  /// owner (OPTION-C: a dialog is only ever answered by a person).
  public struct Invocation: Equatable, Sendable {
    public let executable: String
    public let args: [String]
    public let cwd: String
  }

  public static func claudeInvocation(
    for row: ThreadSessionRow, claudePath: String, permissionFlag: String? = nil, talosHome: String? = nil
  ) -> Invocation? {
    guard row.needsMac, row.cwd.hasPrefix("/"), !row.cwd.contains("\0") else { return nil }
    var args: [String] = []
    if let p = permissionFlag, !p.isEmpty { args.append(p) }
    // Without the Talos home there is nothing to fence, and a hand-opened claude with no fence is not offered.
    guard let home = talosHome, WorkerFence.isSafe(talosHome: home) else { return nil }
    // the optional guards ride in the same inline settings, since Claude Code takes one --settings; the Talos-home deny goes in after
    // them, as a union, exactly as a worker's does
    guard let base = (try? JSONSerialization.jsonObject(with: Data(pluginsOffSettings.utf8))) as? [String: Any],
      let merged = GuardsSettings.merged(base, talosHome: home),
      let fenced = WorkerFence.applying(merged, talosHome: home),
      let data = try? JSONSerialization.data(withJSONObject: fenced, options: [.sortedKeys])
    else { return nil }
    args += ["--settings", String(decoding: data, as: UTF8.self)]
    return Invocation(executable: claudePath, args: args, cwd: row.cwd)
  }

  /// Inline `--settings` JSON that turns both channel plugins off for this one session (never the owner's user settings).
  public static let pluginsOffSettings: String = {
    let d = try? JSONSerialization.data(
      withJSONObject: ["enabledPlugins": [WorkerSpec.telegramPlugin: false, WorkerSpec.imessagePlugin: false]],
      options: [.sortedKeys])
    return d.map { String(decoding: $0, as: UTF8.self) } ?? "{}"
  }()

  /// The env a hand-opened claude gets: the login environment workers use, minus tmux's and anything that makes it join
  /// Talos as a channel session, with the channel state dirs pointed at an empty folder so a plugin that starts anyway
  /// finds no token and never signals the main agent's poller.
  public static func claudeEnvironment(
    from base: [String: String], deliberate: [String: String] = [:], talosHome: String? = nil
  ) -> [String: String] {
    // `base` may be the app's own process environment: drop what a Claude session left in it. `deliberate` (the
    // login/desktop.json env) comes after, with the markers refused there too.
    var env = ClaudeEnvScrub.scrub(base)
    for (k, v) in deliberate where !ClaudeEnvScrub.isSessionMarker(k) { env[k] = v }
    for k in ["TMUX", "TMUX_PANE", "TMUX_TMPDIR", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "TERM_SESSION_ID"] { env.removeValue(forKey: k) }
    for k in WorkerSpec.strippedEnv { env.removeValue(forKey: k) }
    for k in Array(env.keys) where WorkerSpec.strippedPrefixes.contains(where: { k.hasPrefix($0) }) { env.removeValue(forKey: k) }
    if let home = talosHome {
      let none = WorkerSpec.noChannelDir(talosHome: home)
      env["TELEGRAM_STATE_DIR"] = none
      env["IMESSAGE_STATE_DIR"] = none
    }
    env["TERM"] = "xterm-256color"
    env["COLORTERM"] = "truecolor"
    return env
  }
}
