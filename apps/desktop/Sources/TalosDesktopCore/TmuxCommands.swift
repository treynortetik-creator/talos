import Foundation

/// argv builders and output parsers for tmux (DESKTOP-SPEC 4.6). Nothing here launches a process. Every command names
/// our own socket (`-L`) and config (`-f`), so the owner's tmux servers and `~/.tmux.conf` are never involved.
/// Pane commands target the supervised pane by its stable id (`%N`, read when the pane is created), never "the
/// session's active pane": a second pane split in a viewer must not blind the supervisor or receive its keys
/// (D1-REVIEW finding 1). Session commands use `=name` (exact match; tmux otherwise prefix-matches names).
public struct TmuxCommands: Equatable, Sendable {
  public var tmux: String
  public var socket: String
  public var configPath: String
  public var session: String
  /// The supervised pane (`%N`). nil only before the pane exists; then pane commands fall back to `=name:`.
  public var paneId: String?

  public static let defaultSocket = "talos"
  public static let mainSession = "agent"
  public static let minimumVersion = (3, 2)

  public init(tmux: String, socket: String = defaultSocket, configPath: String, session: String = mainSession) {
    self.tmux = tmux
    self.socket = socket
    self.configPath = configPath
    self.session = session
  }

  /// A session name tmux can always target exactly: ASCII letters, digits, `_` and `-`, starting with a letter, at most
  /// 40 characters. tmux accepts `a.b` or `a:b` as names but can't target them (D1-REVIEW finding 2), and `%`/`@`/`$`
  /// prefixes mean pane/window/session ids. Option C uses `t-<thread_id>` (ids `^[a-z][a-z0-9_]{0,31}$`).
  public static func isValidSessionName(_ s: String) -> Bool {
    guard let first = s.first, first.isASCII, first.isLetter, s.count <= 40 else { return false }
    return s.allSatisfy { ($0.isASCII && ($0.isLetter || $0.isNumber)) || $0 == "_" || $0 == "-" }
  }

  public var hasValidSessionName: Bool { Self.isValidSessionName(session) }

  /// A pane id as tmux prints it: `%` then digits.
  public static func isPaneId(_ s: String) -> Bool {
    s.count >= 2 && s.first == "%" && s.dropFirst().allSatisfy { $0.isASCII && $0.isNumber }
  }

  public func withPane(_ id: String?) -> TmuxCommands {
    var c = self
    c.paneId = id.flatMap { Self.isPaneId($0) ? $0 : nil }
    return c
  }

  var base: [String] { [tmux, "-L", socket, "-f", configPath] }
  public var sessionTarget: String { "=\(session)" }
  public var paneTarget: String { paneId ?? "=\(session):" }

  static func envFlags(_ env: [String: String]) -> [String] {
    env.keys.sorted().flatMap { ["-e", literalArg("\($0)=\(env[$0] ?? "")")] }
  }

  /// tmux ends a command at an argv element that ends in `;` (or is just `;`) and starts the next command after it, so an
  /// agent argument like `be brief;` ran nothing ("unknown command") and the rest of the list was read as commands. One
  /// backslash before that last `;` is removed by tmux and the element arrives as typed (OBSERVED, tmux 3.8, private socket:
  /// `be brief;`, `;`, `a;;`, `$HOME;` and one ending in a backslash and `;` all arrive exactly; `;` inside an element is
  /// left alone). Every element a user can influence goes through this: the agent's argv, env values, the folder, typed text.
  /// The `;` that separates two commands of one list (respawn then clear-history, if-shell then send-keys) is NOT passed here.
  public static func literalArg(_ element: String) -> String {
    guard element.hasSuffix(";") else { return element }
    return String(element.dropLast()) + "\\;"
  }

  public static func version() -> [String] { ["-V"] }

  /// `tmux 3.8`, `tmux 3.3a`, `tmux next-3.6` → (3, 8). nil when unreadable.
  public static func parseVersion(_ out: String) -> (Int, Int)? {
    guard let tok = out.split(separator: " ").dropFirst().first else { return nil }
    let digits = tok.drop { !$0.isNumber }
    let parts = digits.split(separator: ".")
    guard parts.count >= 2, let major = Int(parts[0]) else { return nil }
    let minor = Int(parts[1].prefix { $0.isNumber }) ?? 0
    return (major, minor)
  }

  public static func versionIsSupported(_ out: String) -> Bool {
    guard let v = parseVersion(out) else { return false }
    return v.0 > minimumVersion.0 || (v.0 == minimumVersion.0 && v.1 >= minimumVersion.1)
  }

  public func hasSession() -> [String] { base + ["has-session", "-t", sessionTarget] }

  /// tmux expands `-c` as a format, so a folder literally named `#{l:..}` would run somewhere else than the one checked.
  /// `##` is a literal `#`.
  public static func literalPath(_ path: String) -> String { path.replacingOccurrences(of: "#", with: "##") }

  public func newSession(argv: [String], env: [String: String], cwd: String, cols: Int = 120, rows: Int = 40)
    -> [String]
  {
    base + [
      "new-session", "-d", "-P", "-F", "#{pane_id}", "-s", session, "-x", String(cols), "-y", String(rows), "-c",
      Self.literalArg(Self.literalPath(cwd)),
    ] + Self.envFlags(env) + ["--"] + argv.map(Self.literalArg)
  }

  /// A fresh window for the agent when our pane is gone but the session still holds someone else's pane.
  public func newWindow(argv: [String], env: [String: String], cwd: String) -> [String] {
    base + ["new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "\(sessionTarget):", "-c", Self.literalArg(Self.literalPath(cwd))]
      + Self.envFlags(env) + ["--"] + argv.map(Self.literalArg)
  }

  /// The tmux server's own environment (`global`) or the session's. A server started by a polluted process carries
  /// that process's variables into every pane, and `-e` on a new pane can only add.
  public func showEnvironment(global: Bool) -> [String] {
    base + ["show-environment"] + (global ? ["-g"] : ["-t", sessionTarget])
  }

  /// Marks `name` removed, so panes started afterwards do not get it.
  public func removeEnvironment(_ name: String, global: Bool) -> [String] {
    base + ["set-environment"] + (global ? ["-g"] : ["-t", sessionTarget]) + ["-r", name]
  }

  /// Respawns the pane and clears its history in the same tmux invocation. The two run back to back inside the server, before
  /// the new child can print: a separate `clear-history` after this one could run after a child that exits at once had printed
  /// its last line, and wipe it (OBSERVED, tmux 3.8: the line was in history once "Pane is dead" scrolled it there).
  public func respawnPane(argv: [String], env: [String: String], cwd: String) -> [String] {
    base + ["respawn-pane", "-k", "-t", paneTarget, "-c", Self.literalArg(Self.literalPath(cwd))] + Self.envFlags(env)
      + ["--"] + argv.map(Self.literalArg) + [";", "clear-history", "-t", paneTarget]
  }

  public static let paneStateFormat =
    "#{pane_pid}|#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}|#{window_activity}|#{session_created}|#{pane_id}"

  public func paneState() -> [String] { base + ["display-message", "-p", "-t", paneTarget, Self.paneStateFormat] }

  public func capturePane() -> [String] { base + ["capture-pane", "-p", "-J", "-t", paneTarget] }

  /// The screen with its colours (`-e`): the placeholder in Claude's input box is dim, a draft is not (`InputBoxAttributes`).
  public func capturePaneEscaped() -> [String] { base + ["capture-pane", "-e", "-p", "-J", "-t", paneTarget] }

  /// The screen plus `lines` of history. A dead pane needs it: tmux 3.8 scrolls the last output into history to print
  /// "Pane is dead (…)" (OBSERVED).
  public func captureRecent(lines: Int) -> [String] {
    base + ["capture-pane", "-p", "-J", "-S", "-\(lines)", "-t", paneTarget]
  }

  /// Raw bytes as hex (`send-keys -H`), so nothing is interpreted as a key name.
  public func sendBytes(_ bytes: [UInt8]) -> [String] {
    base + ["send-keys", "-t", paneTarget, "-H"] + bytes.map { String(format: "%02x", $0) }
  }

  /// `1` when the pane is in a mode (copy mode after a wheel scroll): `send-keys` then goes to the mode, not the agent.
  public func paneInMode() -> [String] { base + ["display-message", "-p", "-t", paneTarget, "#{pane_in_mode}"] }

  /// Leaves copy mode (or any mode) in our pane.
  public func cancelMode() -> [String] { base + ["send-keys", "-t", paneTarget, "-X", "cancel"] }

  /// Leaves copy mode (only when the pane is in one) and sends the bytes, as ONE tmux invocation. Two invocations leave a gap:
  /// a wheel-up landing between `send-keys -X cancel` and `send-keys -H` puts the pane back in copy mode and the key goes to
  /// the mode, not the agent (OBSERVED: the restart's one Enter swallowed, the restart killed 15 s later). tmux runs one
  /// command list without returning to its event loop, so nothing can slip in between.
  /// `if-shell -F` (not `copy-mode -q`) because it exists on every tmux we accept (>= 3.2); a bare `send-keys -X cancel`
  /// chained with `;` fails "not in a mode" and drops the bytes when the pane is not in a mode (the normal case).
  public func sendBytesLeavingMode(_ bytes: [UInt8]) -> [String] {
    base + [
      "if-shell", "-F", "-t", paneTarget, "#{pane_in_mode}", "send-keys -t \(paneTarget) -X cancel", ";",
      "send-keys", "-t", paneTarget, "-H",
    ] + bytes.map { String(format: "%02x", $0) }
  }

  /// Literal text with no key-name parsing (`-l`). The Enter goes separately: a program reads one chunk as a paste.
  public func sendLiteral(_ text: String) -> [String] {
    base + ["send-keys", "-t", paneTarget, "-l", "--", Self.literalArg(text)]
  }
  /// `n` Backspace keys in one invocation: each deletes the character before the cursor, and none does anything at the start of the box.
  public func sendBackspaces(_ n: Int) -> [String] { base + ["send-keys", "-t", paneTarget] + Array(repeating: "BSpace", count: n) }
  public func sendEnter() -> [String] { base + ["send-keys", "-t", paneTarget, "Enter"] }

  /// One of the three keys a tap on a dialog may send, by tmux key NAME (tmux turns it into the bytes the pane's own cursor-key mode wants:
  /// Claude's Select runs with application cursor keys, so raw bytes would be the wrong ones). The type admits Up, Down and Enter and nothing
  /// else: no text, no digit, no raw byte. It leaves copy mode first, in the same invocation (see `sendBytesLeavingMode`).
  public func sendDialogKey(_ key: DialogKey) -> [String] {
    base + [
      "if-shell", "-F", "-t", paneTarget, "#{pane_in_mode}", "send-keys -t \(paneTarget) -X cancel", ";", "send-keys", "-t", paneTarget, key.rawValue,
    ]
  }

  public func clearHistory() -> [String] { base + ["clear-history", "-t", paneTarget] }

  /// Every pane of the session (all windows), by id.
  public func listPanes() -> [String] { base + ["list-panes", "-s", "-t", sessionTarget, "-F", "#{pane_id}"] }

  public func killSession() -> [String] { base + ["kill-session", "-t", sessionTarget] }

  /// `#{client_activity}` (seconds since 1970) of each client attached to the session (Option C's typing guard).
  public func listClientsActivity() -> [String] {
    base + ["list-clients", "-t", sessionTarget, "-F", "#{client_activity}"]
  }

  /// `listClientsActivity` output → one time per attached client, empty when nobody is attached. nil when any row can't
  /// be read: that isn't "nobody is typing".
  public static func parseClientActivity(_ out: String) -> [Double]? {
    var rows = out.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
    if rows.last == "" { rows.removeLast() }
    var times: [Double] = []
    for r in rows {
      guard let t = Double(r) else { return nil }
      times.append(t)
    }
    return times
  }

  /// A failed `has-session` means the session is gone only when tmux itself says so: it answered "no such session", or
  /// nothing is listening on the socket. Any other failure (a timeout, the socket refusing under load, `Process.run`
  /// throwing at the file limit) says nothing about the worker.
  public static func saysGone(status: Int32, stderr: String, timedOut: Bool) -> Bool {
    guard status != 0, !timedOut else { return false }
    return stderr.contains("can't find session") || stderr.contains("no server running")
      || (stderr.contains("error connecting to") && stderr.contains("(No such file or directory)"))
  }

  /// tmux's own answer when the command reached a server that was shutting down: the last session had just been killed
  /// and the server was on its way out, so nothing ran. Reproduced with plain tmux (kill the only session, then at once
  /// `new-session` on the same socket: about 1 in 600 fails this way, more under load). A command that fails like this
  /// created nothing, so asking again is safe: the second try finds the socket gone and starts a new server. A timeout is
  /// never this: the command may have run, and asking again could start the agent twice. The wording is the one in tmux 3.8's
  /// binary (`CLIENT_EXIT_LOST_SERVER`'s message); the older "lost server" is not in it.
  public static func saysServerWentAway(status: Int32, stderr: String, timedOut: Bool) -> Bool {
    guard status != 0, !timedOut else { return false }
    return stderr.contains("server exited unexpectedly")
  }

  /// The terminal pane's viewer (D2). `-f` is harmless when the server already runs.
  /// `-u`: a Finder or login-item launch has no LANG/LC_*, and without it tmux treats the client as not UTF-8 and draws every
  /// non-ASCII cell as `_` (Claude's prompt glyph, boxes, bullets). Also what "Copy tmux attach command" copies.
  public func attach() -> [String] { base + ["-u", "attach-session", "-t", sessionTarget] }

  /// Session user options (`@talos_*`) remember what the running pane was launched with, across app restarts.
  public func setOption(_ key: String, _ value: String) -> [String] {
    base + ["set-option", "-t", "\(sessionTarget):", "@\(key)", Self.literalArg(value)]
  }

  public func showOption(_ key: String) -> [String] {
    base + ["show-options", "-v", "-t", "\(sessionTarget):", "@\(key)"]
  }

  public struct PaneState: Equatable, Sendable {
    /// nil once the pane is dead (tmux 3.8 prints an empty `#{pane_pid}` for a dead pane: OBSERVED).
    public var pid: Int32?
    public var dead: Bool
    public var exitStatus: Int32?
    public var exitSignal: Int32?
    /// Last output, seconds since 1970 (`#{window_activity}`).
    public var activity: Double?
    public var sessionCreated: Double?
    public var paneId: String? = nil
  }

  public static func parsePaneState(_ out: String) -> PaneState? {
    let line = out.split(separator: "\n").first.map(String.init) ?? ""
    let f = line.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
    guard f.count >= 6, f[1] == "0" || f[1] == "1" else { return nil }
    let pid = Int32(f[0]).flatMap { $0 > 0 ? $0 : nil }
    let dead = f[1] == "1"
    if !dead && pid == nil { return nil }
    return PaneState(
      pid: pid, dead: dead, exitStatus: Int32(f[2]), exitSignal: parseSignal(f[3]), activity: Double(f[4]),
      sessionCreated: Double(f[5]), paneId: f.count > 6 && isPaneId(f[6]) ? f[6] : nil)
  }

  /// tmux 3.8 answers `display-message` for a missing pane or session with exit 0 and a row of empty fields (`||||||`),
  /// not an error. That row is "gone"; any other row that does not parse says nothing.
  public static func isEmptyPaneRow(_ out: String) -> Bool {
    let line = out.split(separator: "\n", omittingEmptySubsequences: false).first.map(String.init) ?? ""
    return line.contains("|") && line.allSatisfy { $0 == "|" || $0 == " " }
  }

  /// `#{pane_dead_signal}` is a lowercase name in tmux 3.8 (`term`, `kill`: OBSERVED), a number in older builds.
  public static func parseSignal(_ s: String) -> Int32? {
    let t = s.trimmingCharacters(in: .whitespaces).lowercased()
    if t.isEmpty { return nil }
    if let n = Int32(t) { return n }
    let names: [String: Int32] = [
      "hup": 1, "int": 2, "quit": 3, "ill": 4, "trap": 5, "abrt": 6, "emt": 7, "fpe": 8, "kill": 9, "bus": 10,
      "segv": 11, "sys": 12, "pipe": 13, "alrm": 14, "term": 15, "usr1": 30, "usr2": 31,
    ]
    let bare = t.hasPrefix("sig") ? String(t.dropFirst(3)) : t
    return names[bare] ?? -1
  }

  /// capture-pane output → rows, bottom-anchored (trailing blank rows dropped).
  public static func parseCapture(_ out: String) -> [String] {
    var rows = out.components(separatedBy: "\n").map { $0.replacingOccurrences(of: "\r", with: "") }
    while let last = rows.last, last.trimmingCharacters(in: .whitespaces).isEmpty { rows.removeLast() }
    return rows
  }
}
