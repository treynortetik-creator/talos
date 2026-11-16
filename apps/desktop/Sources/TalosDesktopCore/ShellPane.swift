import Foundation

/// The owner's own shell in the Talos window's Terminal pane (docs/TERMINAL-PANE.md). The page reserves a slot and says where it
/// is and which thread it belongs to (`shell_pane`); the Mac app lays a native terminal over it. The shell is the owner's login
/// shell on a pty this app owns, never the agent's tmux session. Everything here is pure: what the shell is started with.
///
/// What the page can say is geometry and a thread id. It cannot name a folder, a command, an environment or any input: the
/// folder is read from this Mac's own config, and what the shell reads is what the owner types or pastes into the native view,
/// plus the terminal's own answers to a program that asks it something (where the cursor is, what kind of terminal it is).
/// The clipboard is not among those answers: the pane's view refuses the escape sequence that reads or sets it.
public enum ShellPane {
  /// Listed in the user agent (`TalosFeatures/…`) so the page knows this app lays a shell over the slot.
  public static let shellFeature = "shell-pane"
  /// The most tabs one thread's pane holds, and the most shells alive in the app at once. A page that asks for a pane for one
  /// thread id after another can therefore start only so many idle shells, none of which it can type into.
  public static let maxTabsPerThread = 6
  public static let maxShells = 16
  /// The most shells the page's own messages may start in `pageStartWindow` seconds (the owner's + is not counted): each start
  /// runs the owner's login profile, so a page that opens and closes a pane in a loop is held to this.
  public static let maxPageStarts = 12
  public static let pageStartWindow: TimeInterval = 60

  /// Whether one more page-asked start is inside the limit, given when the earlier ones were.
  public static func pageMayStart(now: Date, earlier: [Date]) -> Bool {
    earlier.filter { now.timeIntervalSince($0) < pageStartWindow }.count < maxPageStarts
  }
  /// The slot is used only with room for this many cells; smaller, and the page's own text stays showing.
  public static let minColumns = 20
  public static let minRows = 4

  /// What the shell inherits: this app's environment without what describes another terminal, a Claude Code session or a Talos
  /// session (`LoginShellEnv.build`, the same scrub the agent's launch uses, and then every `TALOS_` variable and the bridge's
  /// protocol switch: an app started from a thread session holds those), and with none of `desktop.json` `env`, which is the
  /// agent's. The login shell then reads the owner's own profile on top, so what the owner exports there is back.
  public static func environment(from process: [String: String]) -> [String: String] {
    var env = LoginShellEnv.build(shellEnv: process, overrides: [:])
      .filter { !$0.key.hasPrefix("TALOS_") && $0.key != "MCP_PROTOCOL_NEGOTIATION" }
    if env["LC_ALL"] == nil, env["LC_CTYPE"] == nil, env["LANG"] == nil { env["LANG"] = "en_US.UTF-8" }
    return env
  }

  public struct Shell: Equatable, Sendable {
    public var executable: String
    /// `argv[0]`: the shell's name with a leading dash, which is how a shell is told it is a login shell.
    public var execName: String
    public init(executable: String, execName: String) {
      self.executable = executable
      self.execName = execName
    }
  }

  /// The owner's login shell: the account's own (`pw_shell`), else `$SHELL`, else zsh. Only an absolute path to something
  /// executable is taken.
  public static func loginShell(account: String?, env: String?, isExecutable: (String) -> Bool) -> Shell {
    let path = [account, env].compactMap { $0 }.first { $0.hasPrefix("/") && isExecutable($0) } ?? "/bin/zsh"
    return Shell(executable: path, execName: "-" + (path.split(separator: "/").last.map(String.init) ?? "zsh"))
  }

  /// Where a thread's shell starts: the thread's own folder as this Mac's `config.json` has it (`session_opts.cwd`, a sub-thread
  /// taking its parent's when it sets none), else the agent folder, else home. A folder that is not there falls through to the
  /// next. The page's idea of the folder is never asked.
  ///
  /// Only a thread with its own session (`session: "dedicated"`) has a folder of its own: that is where its agent works, and
  /// it is the only case in which the bridge checks the folder before it writes it (refused roots, on disk). A `cwd` on any
  /// other thread was never checked by anyone, so it is not used and the shell starts in the agent folder, where Main works.
  public static func folder(
    threadId: String, config: Data?, agentDir: String, home: String, isFolder: (String) -> Bool
  ) -> String {
    func usable(_ p: String?) -> String? {
      guard let p, !p.isEmpty else { return nil }
      let full = PathUtil.expandTilde(p, home: home)
      return full.hasPrefix("/") && isFolder(full) ? full : nil
    }
    if let config, let root = (try? JSONSerialization.jsonObject(with: config)) as? [String: Any],
      let all = (root["threads"] as? [Any])?.compactMap({ $0 as? [String: Any] }),
      let t = all.first(where: { $0["id"] as? String == threadId }), isDedicated(t)
    {
      if let own = usable(SubThreads.own(t).cwd) { return own }
      if case .live(let parent) = SubThreads.link(t, in: all), isDedicated(parent), let up = usable(SubThreads.own(parent).cwd) {
        return up
      }
    }
    return usable(agentDir) ?? home
  }

  private static func isDedicated(_ t: [String: Any]) -> Bool {
    t["session"] as? String == "dedicated" && !SubThreads.isArchived(t["archived"])
  }

  /// A tab's label: the folder's own name and which shell it is.
  public static func tabTitle(folder: String, number: Int) -> String {
    let name = folder.split(separator: "/").last.map(String.init) ?? "/"
    let clean = String(name.unicodeScalars.filter { $0.value >= 0x20 && $0.value != 0x7f }.prefix(24))
    return number == 1 ? clean : "\(clean) \(number)"
  }
}
