import Foundation

/// The words of the "Move to Applications folder" question and what follows it.
public enum AppMoveCopy {
  public static let title = "Move Talos to your Applications folder?"
  public static let bodyElsewhere =
    "Talos works best from the Applications folder in your home folder: that is where it can update itself and start when you log in. It will copy itself there and open again."
  public static let bodyTemporary =
    "macOS is running Talos from a temporary copy, so it can't update itself or start when you log in. Move it to your Applications folder? It copies itself there and opens again."
  public static let bodySystemFolder =
    "Talos can only update itself from the Applications folder in your home folder, not the one for everyone on this Mac. Move it there so Talos can update itself? It copies itself there and opens again."
  public static func body(_ r: AppLocation.Reason) -> String {
    switch r {
    case .temporary: return bodyTemporary
    case .systemApplications: return bodySystemFolder
    case .elsewhere: return bodyElsewhere
    }
  }
  public static let move = "Move to Applications folder"
  public static let doNotMove = "Do Not Move"
  public static let failedTitle = "Talos couldn't move itself"
  public static func failed(_ why: String) -> String {
    "\(why) You can drag Talos into your Applications folder yourself, then open it from there."
  }
  public static let keptTitle = "Talos is already in your Applications folder"
  public static let keptTalos = "There's already a Talos in your Applications folder. Talos will keep using that one."
  public static let keptOther = "There's already an app called Talos in your Applications folder that isn't this one, so Talos did not move. It keeps running from here."
  public static let all = [title, bodyElsewhere, bodyTemporary, bodySystemFolder, move, doNotMove, failedTitle, keptTitle, keptTalos, keptOther]
}

/// What the mover needs to know about an app bundle to decide whether it may be replaced.
public struct BundleFacts: Equatable, Sendable {
  public var bundleID: String?
  public var shortVersion: String?
  public var buildVersion: String?
  /// Built from a source checkout (`TalosCheckout` in its Info.plist): the owner's own copy, made by install.sh.
  public var hasCheckoutStamp: Bool
  /// The Team ID it is signed with, nil when unsigned or unknown.
  public var team: String?
  public var running: Bool

  public init(bundleID: String?, shortVersion: String?, buildVersion: String?, hasCheckoutStamp: Bool, team: String?, running: Bool) {
    self.bundleID = bundleID
    self.shortVersion = shortVersion
    self.buildVersion = buildVersion
    self.hasCheckoutStamp = hasCheckoutStamp
    self.team = team
    self.running = running
  }

  /// Reads Contents/Info.plist (nothing else); nil when there is none.
  public static func read(path: String, team: String?, running: Bool) -> BundleFacts? {
    guard let data = FileManager.default.contents(atPath: path + "/Contents/Info.plist"),
      let d = (try? PropertyListSerialization.propertyList(from: data, options: [], format: nil)) as? [String: Any]
    else { return nil }
    return BundleFacts(
      bundleID: d["CFBundleIdentifier"] as? String, shortVersion: d["CFBundleShortVersionString"] as? String,
      buildVersion: d["CFBundleVersion"] as? String, hasCheckoutStamp: d["TalosCheckout"] != nil, team: team, running: running)
  }
}

public enum AppVersion {
  /// Dotted numbers compared part by part (a missing part is 0). nil when either has a part that is not a number.
  public static func compare(_ a: String?, _ b: String?) -> Int? {
    func parts(_ s: String?) -> [Int]? {
      guard let s, !s.isEmpty else { return nil }
      let p = s.split(separator: ".", omittingEmptySubsequences: false).map { Int($0) }
      return p.contains { $0 == nil } ? nil : p.map { $0! }
    }
    guard var x = parts(a), var y = parts(b) else { return nil }
    while x.count < y.count { x.append(0) }
    while y.count < x.count { y.append(0) }
    for (m, n) in zip(x, y) where m != n { return m < n ? -1 : 1 }
    return 0
  }

  /// `existing` is OLDER than `mine`: by the short version and the build number, neither newer and at least one older.
  public static func isOlder(_ existing: BundleFacts, than mine: BundleFacts) -> Bool {
    guard let s = compare(existing.shortVersion, mine.shortVersion) else { return false }
    let results = [s] + [compare(existing.buildVersion, mine.buildVersion)].compactMap { $0 }
    return !results.contains { $0 > 0 } && results.contains { $0 < 0 }
  }
}

/// Copies the running app into ~/Applications and says where it went. Every file step is a closure so a test can refuse what the real
/// disk refuses; nothing here opens a window or quits anything.
public enum AppMover {
  public static let bundleID = "app.talos.desktop"

  public struct Seam: @unchecked Sendable {
    public var isWritableDir: (String) -> Bool
    public var exists: (String) -> Bool
    public var makeDir: (String) -> Bool
    public var copy: (String, String) throws -> Void
    /// Removes the download flag from the copy (and everything in it). false: it could not be done.
    public var stripQuarantine: (String) -> Bool
    /// Puts a folder in the Trash and says where it went; nil: it stayed where it was.
    public var trash: (String) -> String?
    /// Puts a trashed folder back at a path.
    public var restore: (_ trashed: String, _ to: String) -> Bool
    public var rename: (String, String) throws -> Void
    public var remove: (String) -> Void
    /// What is known about a bundle at a path (nil: it can't be read). `running` is whether it is running now.
    public var facts: (String) -> BundleFacts?

    public init(
      isWritableDir: @escaping (String) -> Bool, exists: @escaping (String) -> Bool, makeDir: @escaping (String) -> Bool,
      copy: @escaping (String, String) throws -> Void, stripQuarantine: @escaping (String) -> Bool, trash: @escaping (String) -> String?,
      restore: @escaping (String, String) -> Bool, rename: @escaping (String, String) throws -> Void, remove: @escaping (String) -> Void,
      facts: @escaping (String) -> BundleFacts?
    ) {
      self.isWritableDir = isWritableDir
      self.exists = exists
      self.makeDir = makeDir
      self.copy = copy
      self.stripQuarantine = stripQuarantine
      self.trash = trash
      self.restore = restore
      self.rename = rename
      self.remove = remove
      self.facts = facts
    }
  }

  public enum Outcome: Equatable, Sendable {
    /// `originalTrashed`: the copy the owner downloaded was put in the Trash too (only possible for a copy that is not the temporary one).
    case moved(to: String, originalTrashed: Bool)
    /// Something is at the destination that must not be replaced; nothing was changed. `isTalos`: it is a Talos (so it can be used).
    case kept(at: String, isTalos: Bool)
    case failed(String)
  }

  public static func destination(home: String, name: String) -> String { AppLocation.destinationFolder(home: home) + "/" + name }

  /// The destination's old Talos may go to the Trash only when ALL hold: it is this app (same bundle id), older, not running, not a
  /// source or development build (the owner's own install.sh copy is never touched), and signed by the same team as this app.
  public static func mayReplace(existing: BundleFacts, mine: BundleFacts) -> Bool {
    guard existing.bundleID == bundleID, mine.bundleID == bundleID else { return false }
    guard AppVersion.isOlder(existing, than: mine) else { return false }
    guard !existing.running, !existing.hasCheckoutStamp else { return false }
    guard let a = existing.team, let b = mine.team, !a.isEmpty, a == b else { return false }
    return true
  }

  public static func move(from source: String, home: String, seam: Seam, tag: String = UUID().uuidString.prefix(8).lowercased()) -> Outcome {
    let name = (source as NSString).lastPathComponent
    let dest = destination(home: home, name: name)
    let dir = (dest as NSString).deletingLastPathComponent
    if (source as NSString).standardizingPath == dest { return .failed("Talos is already in \(dir).") }
    if !seam.exists(dir), !seam.makeDir(dir) { return .failed("Talos couldn't make the folder \(dir).") }
    guard seam.isWritableDir(dir) else { return .failed("Talos may not write to \(dir).") }

    // what is already at the destination decides everything before a byte is copied
    var oldTrashed: String?
    if seam.exists(dest) {
      let there = seam.facts(dest)
      guard let there, let mine = seam.facts(source), mayReplace(existing: there, mine: mine) else {
        return .kept(at: dest, isTalos: there?.bundleID == bundleID)
      }
    }

    // copy beside the final place under a hidden name, so the Applications folder never holds a half copy under Talos's own name
    let temp = dir + "/.Talos-moving-\(tag).app"
    do { try seam.copy(source, temp) } catch {
      seam.remove(temp)
      return .failed("Copying Talos into \(dir) didn't work.")
    }
    guard seam.stripQuarantine(temp) else {
      // a copy that still carries the download flag would be moved to a temporary place again at the next open
      seam.remove(temp)
      return .failed("Talos copied itself but couldn't clear the download flag on the copy, so it didn't use it.")
    }
    if seam.exists(dest) {
      guard let t = seam.trash(dest) else {
        seam.remove(temp)
        return .failed("An older Talos is in \(dir) and Talos couldn't put it in the Trash.")
      }
      oldTrashed = t
    }
    do { try seam.rename(temp, dest) } catch {
      seam.remove(temp)
      if let t = oldTrashed {
        if seam.restore(t, dest) { return .failed("Talos couldn't finish putting itself in \(dir), and put the older Talos back.") }
        return .failed("Talos couldn't finish putting itself in \(dir), and the older Talos is in your Trash.")
      }
      return .failed("Talos couldn't finish putting itself in \(dir).")
    }
    let original = !AutoUpdate.isTranslocated(source) && seam.trash(source) != nil
    return .moved(to: dest, originalTrashed: original)
  }

  /// Gives the owner write on every non-link file and folder under `root` (and `root`) that lacks it; returns what it changed with the
  /// mode each had, so the caller can put it back. Only ever called on the copy.
  static func withheldOwnerWrite(under root: String) -> [(String, mode_t)] {
    let fm = FileManager.default
    var changed: [(String, mode_t)] = []
    func visit(_ p: String) {
      var st = stat()
      guard lstat(p, &st) == 0, st.st_mode & S_IFMT != S_IFLNK else { return }
      if st.st_mode & S_IWUSR == 0, chmod(p, st.st_mode & 0o7777 | S_IWUSR) == 0 { changed.append((p, st.st_mode & 0o7777)) }
      if st.st_mode & S_IFMT == S_IFDIR, let kids = try? fm.contentsOfDirectory(atPath: p) { for k in kids { visit(p + "/" + k) } }
    }
    visit(root)
    return changed.reversed()  // children before their folders, so a folder is closed last
  }

  /// The real disk. `trash` and `running`/`team` are given so a test can keep the real Trash out of it.
  public static func liveSeam(
    runTool: @escaping (_ args: [String]) -> Bool, team: @escaping (String) -> String?, isRunning: @escaping (String) -> Bool,
    trash: ((String) -> String?)? = nil
  ) -> Seam {
    let fm = FileManager.default
    return Seam(
      isWritableDir: { fm.isWritableFile(atPath: $0) },
      exists: { fm.fileExists(atPath: $0) },
      makeDir: { (try? fm.createDirectory(atPath: $0, withIntermediateDirectories: true)) != nil },
      copy: { try fm.copyItem(atPath: $0, toPath: $1) },
      stripQuarantine: { copy in
        // The app ships a few files read-only (0444: the guard hooks and the installer), and macOS refuses to clear a flag on a file its
        // owner can't write. So, on this COPY only, the owner gets write for the duration of the clear and every mode is put back after:
        // the app itself refuses a hook that can be written, and the mode is not part of the code signature.
        let saved = withheldOwnerWrite(under: copy)
        let cleared = runTool(["/usr/bin/xattr", "-dr", "com.apple.quarantine", copy])
        // a mode that can't be put back is a failure (the move then deletes the copy): the app refuses a hook left writable
        var restored = true
        for (path, mode) in saved where chmod(path, mode) != 0 { restored = false }
        return cleared && restored
      },
      trash: trash ?? { p in
        var out: NSURL?
        guard (try? fm.trashItem(at: URL(fileURLWithPath: p), resultingItemURL: &out)) != nil else { return nil }
        return (out as URL?)?.path
      },
      restore: { (try? fm.moveItem(atPath: $0, toPath: $1)) != nil },
      rename: { try fm.moveItem(atPath: $0, toPath: $1) },
      remove: { try? fm.removeItem(atPath: $0) },
      facts: { BundleFacts.read(path: $0, team: team($0), running: isRunning($0)) })
  }
}

/// Opens the moved app once this one has quit. A plain open (no rescue flag): the new copy starts as a normal launch.
public enum AppRelaunch {
  public static let script = """
    pid="$1"; app="$2"; opener="$3"; settle="$4"; tries=0
    while kill -0 "$pid" 2>/dev/null && [ "$tries" -lt 300 ]; do sleep 0.2; tries=$((tries+1)); done
    sleep "$settle"
    exec "$opener" "$app"
    """
  public static func arguments(pid: Int32, app: String, opener: String = "/usr/bin/open", settle: String = "1") -> [String] {
    ["-c", script, "talos-move-relaunch", String(pid), app, opener, settle]
  }
}

/// The question at launch: ask once when the app runs from a place that breaks updates and start-at-login, move on a yes, say so on any
/// failure. The window, the relaunch and the "asked before" memory are handed in.
public enum AppMoveOffer {
  public enum Result: Equatable, Sendable {
    case notNeeded
    /// Another Talos is already running: it was brought forward and this one quits without asking.
    case otherRunning
    /// The owner said Do Not Move (or had before).
    case declined
    case moved(String)
    /// A Talos (or another app) already sits at the destination and was left alone.
    case kept(String)
    case failed(String)
  }

  public static func run(
    bundlePath: String, home: String, isRelease: Bool, declinedBefore: Bool, otherInstanceRunning: Bool,
    ask: (_ reason: AppLocation.Reason) -> Bool, move: (String) -> AppMover.Outcome, relaunch: (String) -> Void, activateOther: () -> Void,
    rememberDecline: () -> Void, report: (_ title: String, _ message: String) -> Void, recordMoved: () -> Void = {}
  ) -> Result {
    guard let reason = AppLocation.moveReason(bundlePath: bundlePath, home: home, isRelease: isRelease) else { return .notNeeded }
    // a second copy is never started beside the first, and never asks a question the running one already settled
    if otherInstanceRunning {
      activateOther()
      return .otherRunning
    }
    // a copy that is not temporary, already declined: not asked again. A temporary copy is asked every time: it cannot update.
    if reason != .temporary, declinedBefore { return .declined }
    guard ask(reason) else {
      if reason != .temporary { rememberDecline() }
      return .declined
    }
    switch move(bundlePath) {
    case .moved(let to, _):
      recordMoved()  // before the relaunch: the new copy reads it on its first start
      relaunch(to)
      return .moved(to)
    case .kept(let at, let isTalos):
      report(AppMoveCopy.keptTitle, isTalos ? AppMoveCopy.keptTalos : AppMoveCopy.keptOther)
      if isTalos { relaunch(at) }
      return .kept(at)
    case .failed(let why):
      report(AppMoveCopy.failedTitle, AppMoveCopy.failed(why))
      return .failed(why)
    }
  }
}
