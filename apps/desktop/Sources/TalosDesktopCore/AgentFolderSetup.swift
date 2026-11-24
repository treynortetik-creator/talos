import Foundation
import Security

/// The checklist's Agent folder row: Create a new agent, Adopt a Claude Code folder you already use, or Choose a Talos agent
/// folder you have. The pure pieces: what to run, what a result means, and which folders Choose refuses. The app runs the
/// processes (`AgentFolderFlow`).
public enum AgentFolderSetup {
  /// What Talos starts claude with for a folder it set up: the Talos mod and the channel, the same flags `install.sh` gives
  /// `desktop.json`.
  public static func launchArgs(repo: String) -> [String] {
    ["--plugin-dir", "\(repo)/plugins/talos-app-mod", "--dangerously-load-development-channels", "server:talos-app"]
  }

  /// Create runs the clone's own `install.sh`: no Mac app step (this app is already running), no question (the owner
  /// pressed Create). It never deletes, and it refuses a folder that is not empty and not a Talos agent.
  public static func installArguments(repo: String, dir: String) -> [String] {
    ["\(repo)/install.sh", "--agent-dir", dir, "--no-app", "--yes"]
  }

  /// The scheduler (Chronos) is added by that same installer run, never by a second one. A scheduler that could not be added never fails
  /// the run: the installer exits 0 and leaves a marker (docs/SETUP.md, "When the scheduler could not be added"). The app only reads it.
  /// Where it is: the installer's own rule, `${XDG_CONFIG_HOME:-$HOME/.config}/talos/chronos-not-added.json`, worked out from the very
  /// environment the installer child gets (an empty XDG_CONFIG_HOME counts as unset; HOME falls back to the app's own).
  public static func chronosMarkerPath(env: [String: String], fallbackHome: String) -> String {
    if let xdg = env["XDG_CONFIG_HOME"], !xdg.isEmpty { return xdg + "/talos/chronos-not-added.json" }
    let home = env["HOME"].flatMap { $0.isEmpty ? nil : $0 } ?? fallbackHome
    return home + "/.config/talos/chronos-not-added.json"
  }

  /// Whether anything is at the marker path: a file, an empty or damaged or unreadable one, a folder, a link, a dangling link. Asked
  /// with lstat and never by reading or parsing. Only "nothing there" (ENOENT, ENOTDIR) is absent; any other answer (a folder that
  /// cannot be searched) is not known to be absent, and the owner is told the scheduler is not confirmed rather than nothing.
  public static func chronosMarkerPresent(at path: String) -> Bool {
    var st = stat()
    if lstat(path, &st) == 0 { return true }
    return errno != ENOENT && errno != ENOTDIR
  }

  /// Whether the agent folder was a finished Talos agent before this run: `.talos-version` and `CLAUDE.md` are real files and
  /// CLAUDE.md is not still the kit's placeholder (the installer's own test for an install that did not finish). Only then may a
  /// nonzero exit be the scheduler alone.
  public static func agentExisted(dir: String, repo: String) -> Bool {
    func regular(_ p: String) -> Bool {
      var st = stat()
      return lstat(p, &st) == 0 && (st.st_mode & S_IFMT) == S_IFREG
    }
    guard regular(dir + "/.talos-version"), regular(dir + "/CLAUDE.md") else { return false }
    guard let mine = FileManager.default.contents(atPath: dir + "/CLAUDE.md") else { return false }
    return FileManager.default.contents(atPath: repo + "/kit/CLAUDE.md") != mine
  }

  /// What one installer run means for the folder and for the scheduler.
  public struct InstallResult: Equatable, Sendable {
    public var outcome: Outcome
    /// The folder is fine and the scheduler is not added: say `chronosLater`, once.
    public var schedulerLater: Bool
  }

  /// The root installer's own words when the kit's add-only run (the rerun on a finished agent) fails; pinned by a test against the
  /// repository's install.sh. A nonzero exit without them is some other failure.
  public static let kitAddFailedPhrase = "kit/install.sh --add-to-existing failed"

  /// Exit 0: the folder is made; a marker at the path says the scheduler is not added. A nonzero exit on a folder that was NOT there is
  /// the folder failing, as ever. A rerun on a finished agent whose scheduler is still broken is loud: the root installer exits 1 and
  /// says `kitAddFailedPhrase`. Only that, with ALL of these, is "the agent is fine, only the scheduler is not": status 1, the phrase,
  /// the agent was finished before the run (`agentExisted`), the marker is present, and the folder is wired to Talos (`connected`:
  /// its .mcp.json has the talos-app server; a half-made folder has none). Anything else stays the failure it is.
  public static func installResult(status: Int32?, stderr: String, agentExisted: Bool, markerPresent: Bool, connected: Bool)
    -> InstallResult
  {
    let outcome = createOutcome(status: status, stderr: stderr)
    if outcome == .done { return InstallResult(outcome: .done, schedulerLater: markerPresent) }
    if status == 1, stderr.contains(kitAddFailedPhrase), agentExisted, markerPresent, connected {
      return InstallResult(outcome: .done, schedulerLater: true)
    }
    return InstallResult(outcome: outcome, schedulerLater: false)
  }

  /// What the owner is told when the scheduler could not be added (the agent itself is fine).
  public static let chronosLater = "Talos couldn't add its scheduler this time. Your agent works without it."

  /// The kit update path for a kit 1.x folder, as a preview: it changes nothing.
  public static func upgradeArguments(repo: String, dir: String) -> [String] {
    ["\(repo)/kit/scripts/upgrade.sh", "--into", dir, "--dry-run"]
  }

  /// The stamped version of a kit 1.x install (`.talos-version` starting "1."), else nil.
  public static func kit1Version(in dir: String) -> String? {
    guard let d = FileManager.default.contents(atPath: dir + "/.talos-version") else { return nil }
    let v = String(decoding: d, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    return v.hasPrefix("1.") ? v : nil
  }

  /// Whether the folder's `.mcp.json` has a `talos-app` server, which is what the channel flag in `launchArgs` needs.
  public static func connectedToTalos(_ dir: String) -> Bool {
    guard let d = FileManager.default.contents(atPath: dir + "/.mcp.json"),
      let root = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
      let servers = root["mcpServers"] as? [String: Any]
    else { return false }
    return servers["talos-app"] != nil
  }

  /// The clone recorded for a prebuilt app (which carries no `TalosCheckout`): the first line of `<dir>/checkout`. nil when there is none.
  /// Any program running as the owner can write that file, so what it names is only a candidate: `recordedCloneProblem` judges it, and
  /// the owner confirms it once (`AgentFolderFlow`) before it is used. A clone the app made itself (`CloneProvisioner`) is accepted by it.
  public static func recordedCheckout(supportDir: String) -> String? { recordedCheckout(in: [supportDir])?.clone }

  /// The first record that names a clone, and the file it was read from (judged for ownership): the new bundle-id folder first, then the
  /// old `Application Support/Talos` one that earlier installs made. An empty or missing new record falls back to the old.
  public static func recordedCheckout(in dirs: [String]) -> (clone: String, file: String)? {
    for dir in dirs {
      guard let d = FileManager.default.contents(atPath: dir + "/checkout"), let text = String(data: d, encoding: .utf8) else { continue }
      let line = text.split(separator: "\n", omittingEmptySubsequences: false).first.map(String.init) ?? ""
      if !line.isEmpty { return (line, dir + "/checkout") }
    }
    return nil
  }

  /// Why a recorded clone may not be used; nil when it may. The same rules as the guard refresh's checkout (Supervisor
  /// `sessionFolders`): never inside a folder a session works in or can write freely (`unsafe`: the Talos home, the agent folder,
  /// each thread's folder, the temp roots, and the app's own support folder), no link anywhere in its path, and the folder and the
  /// files Talos runs from it owned by this user and writable by no one else. The record file itself is held to the last rule.
  public static func recordedCloneProblem(_ repo: String, recordFile: String, unsafe folders: [String], uid: uid_t = getuid()) -> String? {
    let lead = "The clone recorded for Talos (\(repo)) can't be used:"
    let tail = "In Terminal, cd to your own clone of the Talos repo and run its apps/desktop/scripts/install.sh again."
    if let why = ownedProblem(recordFile, uid: uid) { return "The record of Talos's clone (\(recordFile)) \(why). \(tail)" }
    guard repo.hasPrefix("/") else { return "\(lead) it is not a full path. \(tail)" }
    let trimmed = repo.count > 1 && repo.hasSuffix("/") ? String(repo.dropLast()) : repo
    guard let real = Self.realPath(trimmed) else { return "\(lead) it isn't on this Mac. \(tail)" }
    guard real == trimmed else { return "\(lead) a part of its path is a link (it leads to \(real)). \(tail)" }
    var roots: [String] = []
    for u in folders where u.hasPrefix("/") {
      for v in [u, Self.realPath(u) ?? u] {
        roots.append(v)
        if v.hasPrefix("/private/") { roots.append(String(v.dropFirst("/private".count))) } else { roots.append("/private" + v) }
      }
    }
    if let hit = roots.first(where: { GuardsRefresh.isUnder(real, [$0]) || GuardsRefresh.isUnder($0, [real]) }) {
      return "\(lead) it is in or around \(hit), a folder agent sessions work in. \(tail)"
    }
    for f in [real, real + "/install.sh", real + "/plugins/talos-app-mod", real + "/apps/bridge/src/cli.ts"] {
      if let why = ownedProblem(f, uid: uid) { return "\(lead) \(f) \(why). \(tail)" }
    }
    return nil
  }

  /// The clone the updater may move and run: the one stamped in the app (a local build), else the recorded one, but only when the owner
  /// (or this app, after it made the clone itself) accepted exactly that path in the Keychain and it passes the same judgement as for
  /// Create, Adopt and Choose. A record any program could write is never trusted on its own. nil: none.
  public static func updaterCheckout(
    stamped: String?, record: (clone: String, file: String)?, accepted: String?, unsafe: [String], uid: uid_t = getuid()
  ) -> String? {
    if let stamped, !stamped.isEmpty { return stamped }
    guard let record, accepted == record.clone else { return nil }
    return recordedCloneProblem(record.clone, recordFile: record.file, unsafe: unsafe, uid: uid) == nil ? record.clone : nil
  }

  /// The recorded clone that passes every check but was never accepted (so `updaterCheckout` skipped it): what the owner should be asked
  /// about. nil when there is no record, it is accepted, or it fails the checks (that is a refusal, not a question).
  public static func unacceptedRecordedClone(
    record: (clone: String, file: String)?, accepted: String?, unsafe: [String], uid: uid_t = getuid()
  ) -> String? {
    guard let record, accepted != record.clone else { return nil }
    return recordedCloneProblem(record.clone, recordFile: record.file, unsafe: unsafe, uid: uid) == nil ? record.clone : nil
  }

  /// Whether the app may count a clone it just made itself as accepted, with no click: only the app's own fixed-place clone
  /// (`AutoSetup.cloneFolder`), named by the app's own record file (`AutoSetup.appFolder`/checkout, not the old folder's, not a
  /// hand-written one elsewhere), and passing every check a recorded clone passes. Anything else is asked about, never assumed.
  public static func ownCloneMayBeAccepted(
    clone: String, record: (clone: String, file: String)?, home: String, unsafe: [String], uid: uid_t = getuid()
  ) -> Bool {
    guard let record, record.clone == clone, clone == AutoSetup.cloneFolder(home: home),
      record.file == AutoSetup.appFolder(home: home) + "/checkout"
    else { return false }
    return recordedCloneProblem(clone, recordFile: record.file, unsafe: unsafe, uid: uid) == nil
  }

  /// The folders a recorded clone may not be in or around: the Talos home, the agent folder, each thread's own folder (from the
  /// home's config.json), the app's support folder, and the temp roots. The same set the supervisor keeps its checkout out of.
  public static func sessionFolders(talosHome: String, agentDir: String, configJSON: Data?, supportDir: String) -> [String] {
    var out = [talosHome, agentDir, supportDir]
    if let d = configJSON { out += DedicatedSettings.parse(d).threads.values.compactMap(\.cwd) }
    return out.filter { $0.hasPrefix("/") } + GuardsRefresh.tmpRoots
  }

  /// Why a path Talos trusts fails "a real file or folder (not a link), owned by this user, writable by no one else"; nil when it passes.
  static func ownedProblem(_ path: String, uid: uid_t) -> String? {
    var st = stat()
    guard lstat(path, &st) == 0 else { return "is missing" }
    if (st.st_mode & S_IFMT) == S_IFLNK { return "is a link" }
    if st.st_uid != uid { return "belongs to another user" }
    if st.st_mode & 0o022 != 0 { return "can be written by other users" }
    return nil
  }

  static func realPath(_ p: String) -> String? {
    guard let r = realpath(p, nil) else { return nil }
    defer { free(r) }
    return String(cString: r)
  }

  /// Why the clone this app was built from can't be used, in plain words; nil when it is whole.
  public static func cloneProblem(_ repo: String) -> String? {
    let fm = FileManager.default
    let tail = "Rebuild Talos from a whole clone (apps/desktop/scripts/build-app.sh), or run ./install.sh in Terminal."
    var isDir: ObjCBool = false
    // The path build-app.sh stamped is not on this Mac at all: most likely the app was built on another Mac (its clone path
    // travels in Info.plist). Said as that, since "find" suggests looking for something that was never here.
    if repo.hasPrefix("/"), !fm.fileExists(atPath: repo) {
      return "This Talos was built from \(repo), which isn't on this Mac. Rebuild it from your own clone: in Terminal, "
        + "cd to your clone of the Talos repo and run bash apps/desktop/scripts/build-app.sh --release, then "
        + "bash apps/desktop/scripts/install.sh (or run ./install.sh there)."
    }
    if repo.isEmpty {
      return "Talos doesn't know which clone of the Talos repo to use. In Terminal, cd to your clone and run "
        + "bash apps/desktop/scripts/install.sh again (with the same --from-release line for a prebuilt Talos): it records the clone."
    }
    guard repo.hasPrefix("/"), fm.fileExists(atPath: repo, isDirectory: &isDir), isDir.boolValue else {
      return "Talos can't find the clone it was built from\(repo.isEmpty ? "" : " (\(repo))"). \(tail)"
    }
    if (try? fm.destinationOfSymbolicLink(atPath: repo)) != nil {
      return "The clone Talos was built from (\(repo)) is a link, which Talos will not run scripts through. \(tail)"
    }
    for (path, what) in [
      ("install.sh", "install.sh"), ("apps/bridge/src/cli.ts", "the bridge (apps/bridge)"),
      ("plugins/talos-app-mod", "the Talos mod (plugins/talos-app-mod)"),
    ] where !fm.fileExists(atPath: repo + "/" + path) {
      return "The clone Talos was built from (\(repo)) is missing \(what). \(tail)"
    }
    return nil
  }

  public enum Pick: Equatable, Sendable {
    case ok(String)
    case refused(String)
  }

  /// Choose: a folder that is already a Talos agent. Refuses one that is gone, unreadable, a link, part of the agent
  /// `desktop.json` already names (`currentAgentDir`, nil before setup), or not connected to Talos yet (that is Adopt).
  public static func choose(_ path: String, home: String, currentAgentDir: String?) -> Pick {
    let full = PathUtil.expandTilde(path.trimmingCharacters(in: .whitespaces), home: home)
    let check = AgentFolderCheck.check(path, home: home)
    if check.isProblem { return .refused(check.text) }
    if (try? FileManager.default.destinationOfSymbolicLink(atPath: URL(fileURLWithPath: full).path)) != nil {
      return .refused("\(full) is a link to another folder. Choose the folder it points to.")
    }
    // Real folders, not text: a trailing slash or a link in a parent folder names the same folder.
    let real = PathUtil.canonical(full)
    if let current = currentAgentDir.map({ PathUtil.canonical(PathUtil.expandTilde($0, home: home)) }), current != real {
      if real.hasPrefix(current + "/") || current.hasPrefix(real + "/") {
        return .refused("\(full) belongs to your current agent folder, \(current). Choose that folder itself, or one outside it.")
      }
    }
    if !connectedToTalos(real) { return .refused("\(full) is not connected to Talos yet. Use Adopt to connect it.") }
    return .ok(real)
  }

  public enum Outcome: Equatable, Sendable {
    case done
    /// Adopt found a talos-app server that runs another clone. The owner decides; the text says which.
    case needsConfirm(String)
    case failed(String)
  }

  /// What the installer's exit means. Its own words are passed on (it says what it did and what to do), with its advice to run
  /// it again turned into this app's button.
  public static func createOutcome(status: Int32?, stderr: String) -> Outcome {
    guard let status else { return .failed("Talos couldn't run the installer.") }
    if status == 0 { return .done }
    let lines = stderr.split(separator: "\n").map(String.init).filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
    if status == 3 {
      let missing = lines.filter { $0.hasPrefix("  - ") }.map { $0.dropFirst(4) }
      if !missing.isEmpty {
        return .failed("Something Talos needs is missing. Install it, then press Create again. Nothing was changed.\n" + missing.joined(separator: "\n"))
      }
    }
    let said = appWording(lines.suffix(6).joined(separator: "\n"))
    return .failed(said.isEmpty ? "The installer stopped (exit \(status)) without saying why." : said)
  }

  /// The installer talks to someone in Terminal. These are its sentences with the flags and commands swapped for this app's buttons.
  static func appWording(_ text: String) -> String {
    let swaps: [(String, String)] = [
      ("To point the agent at this clone, run ./install.sh --repoint; otherwise run the install.sh in the clone it points at.", "To point it at this clone, use Adopt, which asks first."),
      ("(the default ~/talos-agent), or pass --allow-synced-folder if you know why.", "(for example ~/talos-agent)."),
      ("Pick a new folder with --agent-dir.", "Pick a new folder."),
      ("run ./install.sh again", "press Create again"),
    ]
    return swaps.reduce(text) { $0.replacingOccurrences(of: $1.0, with: $1.1) }
  }

  /// What `talos-app adopt` exit means: 0 done, 3 a talos-app server that runs another clone, anything else a refusal. The
  /// output is a terminal's, so its refusal is the line that starts "talos-app:".
  public static func adoptOutcome(status: Int32?, output: String) -> Outcome {
    guard let status else { return .failed("Talos couldn't run talos-app adopt.") }
    if status == 0 { return .done }
    let said =
      output.split(separator: "\n").map(String.init).last { $0.hasPrefix("talos-app: ") }?.dropFirst("talos-app: ".count)
      ?? Substring(output.trimmingCharacters(in: .whitespacesAndNewlines))
    if status == 3 { return .needsConfirm(said.replacingOccurrences(of: " Run again with --repoint to point it here.", with: "")) }
    return .failed(said.isEmpty ? "talos-app adopt stopped (exit \(status)) without saying why." : String(said))
  }
}

/// The recorded clone the owner said yes to, last. Create, Adopt and Choose use a recorded clone (`AgentFolderSetup.recordedCheckout`)
/// only when it is this one; another one puts a card in front of the owner first (`AgentFolderFlow`).
public protocol CloneAcceptance: Sendable {
  func accepted() -> String?
  /// Remembers `path` as accepted; false when it could not be stored (then the owner is asked again next time, never skipped).
  @discardableResult func accept(_ path: String) -> Bool
}

/// For tests: in memory. `failing` plays a store that cannot be written.
public final class MemoryCloneAcceptance: CloneAcceptance, @unchecked Sendable {
  private let lock = NSLock()
  private var value: String?
  public var failing = false
  public init(_ value: String? = nil) { self.value = value }
  public func accepted() -> String? { lock.withLock { value } }
  public func accept(_ path: String) -> Bool {
    lock.withLock {
      guard !failing else { return false }
      value = path
      return true
    }
  }
}

/// The app's: one Keychain item (this device only, no prompt ever), kept per signer when the signer changes (`SignerScopedItem`), so
/// a file a session writes can never stand in for the owner's yes. Unreadable reads as "not accepted": the owner is asked.
public struct KeychainCloneAcceptance: CloneAcceptance, @unchecked Sendable {
  public static let service = "com.talos.app.accepted-clone"
  let scoped: SignerScopedItem
  public init(service: String = KeychainCloneAcceptance.service, keychain: SecKeychain? = nil, signer: String? = SignerKey.current()) {
    scoped = SignerScopedItem(service: service, account: "v1", keychain: keychain, signer: signer)
  }
  public func accepted() -> String? {
    if case .accepted(let p) = read() { return p }
    return nil
  }
  /// What the Keychain said: a saved answer, nothing saved, or that it could not be read (locked, denied). The last one is not "not
  /// accepted": the owner is not asked a question the Keychain failed to answer, and is told it could not be read.
  public enum Read: Equatable, Sendable { case accepted(String), notFound, unreadable(OSStatus) }
  public func read() -> Read {
    let (_, d, s) = scoped.resolve()
    if s == errSecItemNotFound { return .notFound }
    guard s == errSecSuccess else { return .unreadable(s) }
    guard let d, let t = String(data: d, encoding: .utf8) else { return .notFound }
    return .accepted(t)
  }
  public func accept(_ path: String) -> Bool {
    let (item, _, s) = scoped.resolve()
    let data = Data(path.utf8)
    if s == errSecSuccess { return item.update(data) == errSecSuccess }
    guard s == errSecItemNotFound else { return false }
    return item.add(data) == errSecSuccess
  }
}

/// What the launch look, the poll and the updater make of the record and the Keychain: a clone to ask about, nothing, or a Keychain that
/// could not answer (never turned into a question).
public enum AllowUpdatesLook: Equatable, Sendable {
  case nothing
  case ask(clone: String)
  case keychainUnreadable(Int32)

  public static func make(
    record: (clone: String, file: String)?, read: KeychainCloneAcceptance.Read, unsafe: [String], uid: uid_t = getuid()
  ) -> AllowUpdatesLook {
    guard record != nil else { return .nothing }
    switch read {
    case .unreadable(let s): return .keychainUnreadable(s)
    case .accepted(let p):
      return AgentFolderSetup.unacceptedRecordedClone(record: record, accepted: p, unsafe: unsafe, uid: uid).map { .ask(clone: $0) } ?? .nothing
    case .notFound:
      return AgentFolderSetup.unacceptedRecordedClone(record: record, accepted: nil, unsafe: unsafe, uid: uid).map { .ask(clone: $0) } ?? .nothing
    }
  }
}
