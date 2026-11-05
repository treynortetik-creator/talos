import Foundation

/// The first-run checklist (DESKTOP-SPEC 6.6): one row per thing the app needs, each green or a one-line fix. Nothing
/// blocks (D10). The inputs are gathered by the app; this decides what each means.
public enum FirstRun {
  public struct Inputs: Equatable, Sendable {
    public var claudeVersion: String?  // nil = not found
    public var authSignedIn: Bool?  // nil = couldn't tell
    public var bunPath: String?
    public var tmuxVersionOutput: String?  // `tmux -V`, nil = not found
    public var bridgeEnvPresent: Bool
    public var agentDir: String
    public var agentDirTrusted: Bool?  // nil = unknown until the first start
    public var home: String
    /// Whether the `talos-app` command can be found (PATH, desktop.json or the agent folder's .mcp.json). nil = not checked: no row.
    public var talosAppFound: Bool?
    /// Whether `desktop.json` exists, which only Create, Adopt, Choose or Import makes. nil = not checked: no row.
    public var setupDone: Bool?
    /// Why the agent folder desktop.json names can't be used (`AgentFolderCheck`), once setup is done. nil = fine.
    public var agentFolderProblem: String?

    public init(
      claudeVersion: String? = nil, authSignedIn: Bool? = nil, bunPath: String? = nil, tmuxVersionOutput: String? = nil,
      bridgeEnvPresent: Bool = false, agentDir: String = "~/talos-agent", agentDirTrusted: Bool? = nil, home: String,
      talosAppFound: Bool? = nil, setupDone: Bool? = nil, agentFolderProblem: String? = nil
    ) {
      self.claudeVersion = claudeVersion
      self.authSignedIn = authSignedIn
      self.bunPath = bunPath
      self.tmuxVersionOutput = tmuxVersionOutput
      self.bridgeEnvPresent = bridgeEnvPresent
      self.agentDir = agentDir
      self.agentDirTrusted = agentDirTrusted
      self.home = home
      self.talosAppFound = talosAppFound
      self.setupDone = setupDone
      self.agentFolderProblem = agentFolderProblem
    }
  }

  public enum State: Equatable, Sendable {
    case ok
    /// A one-line fix. Never a blocker.
    case fix(String)
    case unknown(String)
  }

  public struct Row: Equatable, Sendable, Identifiable {
    public var id: String
    public var title: String
    public var state: State
    public var isOK: Bool { state == .ok }
  }

  public static func rows(_ i: Inputs) -> [Row] {
    var r: [Row] = []
    // The one step that makes the setup. Named, first, and the other rows never point back at a pane that can't help yet.
    if let done = i.setupDone {
      if !done {
        r.append(Row(id: "agentfolder", title: "Agent folder", state: .fix(setupStep)))
      } else if let problem = i.agentFolderProblem {
        r.append(Row(id: "agentfolder", title: "Agent folder", state: .fix(problem)))
      } else {
        r.append(Row(id: "agentfolder", title: "Agent folder: \(i.agentDir)", state: .ok))
      }
    }
    if let v = i.claudeVersion, !v.isEmpty {
      r.append(Row(id: "claude", title: "claude \(v)", state: .ok))
    } else if i.claudeVersion != nil {
      r.append(Row(id: "claude", title: "claude", state: .unknown("Found, but its version couldn't be read.")))
    } else {
      r.append(Row(id: "claude", title: "claude", state: .fix("Not found. Install Claude Code, then reopen Talos.")))
    }
    switch i.authSignedIn {
    case .some(true): r.append(Row(id: "auth", title: "Claude signed in", state: .ok))
    case .some(false):
      r.append(Row(id: "auth", title: "Claude signed in", state: .fix("Not signed in. Run claude in Terminal, type /login, then press Check again.")))
    case .none:
      r.append(Row(id: "auth", title: "Claude signed in", state: .unknown("Couldn't check. If the agent asks you to sign in, run claude in Terminal and type /login.")))
    }
    r.append(
      i.bunPath != nil
        ? Row(id: "bun", title: "bun", state: .ok)
        : Row(id: "bun", title: "bun", state: .fix("Not found. The Talos bridge runs on bun; install it from bun.sh.")))
    if let found = i.talosAppFound {
      r.append(
        found
          ? Row(id: "talosapp", title: "talos-app command", state: .ok)
          : Row(id: "talosapp", title: "talos-app command", state: .fix("Not found, so Sign in can't run. \(MacSettingsText.connectionPath) \u{2192} talos-app command.")))
    }
    if let out = i.tmuxVersionOutput, TmuxCommands.versionIsSupported(out) {
      r.append(Row(id: "tmux", title: "tmux \(out.split(separator: " ").last.map(String.init) ?? "")", state: .ok))
    } else if let out = i.tmuxVersionOutput, !out.isEmpty {
      r.append(
        Row(
          id: "tmux", title: "tmux 3.2 or newer",
          state: .fix("\(out) is older than 3.2: the agent will stop when Talos quits. Update tmux (brew upgrade tmux).")))
    } else {
      r.append(
        Row(
          id: "tmux", title: "tmux 3.2 or newer",
          state: .fix("Not found: the agent will stop when Talos quits. Install tmux (brew install tmux) to keep it running.")))
    }
    r.append(
      i.bridgeEnvPresent
        ? Row(id: "bridge", title: "Bridge settings (bridge.env)", state: .ok)
        : Row(id: "bridge", title: "Bridge settings (bridge.env)", state: .fix("Missing. Run talos-app init --relay-url <your relay>.")))
    switch i.agentDirTrusted {
    // What Talos can really know is whether a human has confirmed a first start (the dev-channel dialog). It can't see
    // whether Claude trusts a folder, so this row says only what it knows.
    case .some(true): r.append(Row(id: "trust", title: "First start confirmed", state: .ok))
    case .some(false):
      r.append(Row(id: "trust", title: "First start confirmed", state: .fix("Choose Start session in the menu bar item if it isn't running, then press Enter on the dev-channel dialog in Terminals….")))
    case .none:
      r.append(
        Row(
          id: "trust", title: "First start confirmed",
          state: .unknown(
            i.setupDone == false
              ? "Comes after the first step above."
              : "Not started yet. The first time, Claude asks about the folder and the dev-channel: answer both in Terminals….")))
    }
    if protectedFolder(i.agentDir, home: i.home) != nil {
      r.append(
        Row(id: "folder", title: "Agent folder location", state: .fix("It is under a folder macOS protects. macOS will ask Talos once.")))
    }
    return r
  }

  public static let setupStep =
    "Not set up. Create a new Talos agent, Adopt a Claude Code folder you already use, or Choose a Talos agent folder you have. Nothing starts until you do. To use your own launch command instead, Import it in \(MacSettingsText.sessionPath)."

  /// The checklist's trust row from what the config holds: nil before setup (nothing can have been confirmed), else whether a
  /// human has confirmed a first start. This is what makes the row's fix state reachable.
  public static func trust(setupDone: Bool, confirmedAt: String?) -> Bool? { setupDone ? (confirmedAt != nil) : nil }

  /// "Desktop", "Documents" or "Downloads" when the path is inside it.
  public static func protectedFolder(_ path: String, home: String) -> String? {
    let p = PathUtil.expandTilde(path, home: home)
    let h = home.hasSuffix("/") ? String(home.dropLast()) : home
    for f in ["Desktop", "Documents", "Downloads"] where p == "\(h)/\(f)" || p.hasPrefix("\(h)/\(f)/") { return f }
    return nil
  }
}

/// Start at login (DESKTOP-SPEC 6.5): `SMAppService.mainApp` first; when it can't register, a LaunchAgent plist with
/// `RunAtLoad` and no `KeepAlive`. The pieces are pure so they are tested without touching the machine's login items.
public enum LoginItemPlan {
  public enum Service: Equatable, Sendable { case enabled, notRegistered, requiresApproval, notFound }

  public enum Outcome: Equatable, Sendable {
    case registered
    /// Registered but macOS wants the owner to approve it.
    case needsApproval(String)
    /// `SMAppService` can't (an ad-hoc app outside /Applications reports notFound): the LaunchAgent was written instead.
    case fellBackToLaunchAgent
    case failed(String)
  }

  public static let approvalMessage = "Approve Talos in System Settings → General → Login Items."

  public static func outcome(afterRegister s: Service) -> Outcome? {
    switch s {
    case .enabled: return .registered
    case .requiresApproval: return .needsApproval(approvalMessage)
    case .notFound: return .fellBackToLaunchAgent
    case .notRegistered: return nil
    }
  }

  public static func launchAgentLabel(bundleId: String) -> String { bundleId }

  public static func launchAgentPath(home: String, bundleId: String) -> String {
    "\(home)/Library/LaunchAgents/\(bundleId).plist"
  }

  /// `RunAtLoad` true, no `KeepAlive` (a login launch, not a supervisor).
  public static func launchAgentPlist(bundleId: String, executable: String) -> Data? {
    let d: [String: Any] = ["Label": bundleId, "ProgramArguments": [executable], "RunAtLoad": true, "ProcessType": "Interactive"]
    return try? PropertyListSerialization.data(fromPropertyList: d, format: .xml, options: 0)
  }
}
