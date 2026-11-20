import Foundation

/// The words of the "there is still a copy in Downloads" question.
public enum DownloadTidyCopy {
  public static let title = "Move the old copy to the Trash?"
  public static let body = "There's still a copy of Talos in your Downloads folder. Move it to the Trash?"
  public static let trash = "Move to Trash"
  public static let keep = "Keep it"
  public static func failed(_ names: [String]) -> String {
    "Talos couldn't move \(names.joined(separator: " and ")) to the Trash. It is still in your Downloads folder; you can delete it yourself."
  }
  public static let all = [title, body, trash, keep]
}

/// What a move to ~/Applications leaves behind for the first launch from there: the version that moved, its bundle id and when.
/// Cleared once the owner has been asked (or there was nothing to ask about), so the question comes once per move.
public enum MoveMarker {
  public static let key = "app.moveToApplications.moved"
  /// A marker this old belongs to a move nobody remembers: dropped without a question.
  public static let maxAge: TimeInterval = 14 * 24 * 3600

  public struct Value: Equatable, Sendable {
    public var version: String
    public var build: String
    public var bundleID: String
    public var movedAt: Date
  }

  public static func record(_ facts: BundleFacts, defaults: UserDefaults, now: Date = Date()) {
    guard let v = facts.shortVersion, let b = facts.buildVersion, let id = facts.bundleID else { return }
    defaults.set(["version": v, "build": b, "bundleID": id, "movedAt": now.timeIntervalSince1970] as [String: Any], forKey: key)
  }

  public static func read(defaults: UserDefaults) -> Value? {
    guard let d = defaults.dictionary(forKey: key), let v = d["version"] as? String, let b = d["build"] as? String,
      let id = d["bundleID"] as? String, let t = d["movedAt"] as? Double
    else { return nil }
    return Value(version: v, build: b, bundleID: id, movedAt: Date(timeIntervalSince1970: t))
  }

  public static func clear(defaults: UserDefaults) { defaults.removeObject(forKey: key) }
}

/// After a move, finds the copy the owner downloaded and offers to Trash it. Looks in ONE folder, its top level only, and never
/// removes anything itself: the Trash step is handed in (the live one is `FileManager.trashItem`, never a delete).
public enum DownloadTidy {
  public struct Candidate: Equatable, Sendable {
    public var path: String
    public var name: String { (path as NSString).lastPathComponent }
  }

  public struct Seam: @unchecked Sendable {
    public var isQuarantined: (String) -> Bool
    public var isRunning: (String) -> Bool
    /// Puts one item in the Trash; false: it stayed where it was.
    public var trash: (String) -> Bool
    public init(isQuarantined: @escaping (String) -> Bool, isRunning: @escaping (String) -> Bool, trash: @escaping (String) -> Bool) {
      self.isQuarantined = isQuarantined
      self.isRunning = isRunning
      self.trash = trash
    }
  }

  public static func zipName(version: String) -> String { "Talos-\(version)-universal.zip" }

  /// Talos.app and the exact zip name, directly inside `downloads`, that are certainly the downloaded copy of `mine`.
  public static func candidates(downloads: String, mine: BundleFacts, minePath: String, seam: Seam) -> [Candidate] {
    guard mine.bundleID == AppMover.bundleID, let version = mine.shortVersion, let build = mine.buildVersion else { return [] }
    let dir = downloads.count > 1 && downloads.hasSuffix("/") ? String(downloads.dropLast()) : downloads
    var found: [Candidate] = []
    // the names as the folder spells them: on a case-insensitive disk "talos.app" would also open as Talos.app
    let names = Set((try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? [])

    let app = dir + "/Talos.app"
    if names.contains("Talos.app"), isPlain(app, directory: true), !samePlace(app, minePath), seam.isQuarantined(app), !seam.isRunning(app),
      let f = BundleFacts.read(path: app, team: nil, running: false),
      f.bundleID == AppMover.bundleID, f.shortVersion == version, f.buildVersion == build
    {
      found.append(Candidate(path: app))
    }

    // a name that holds a path part or another version never matches: only the running version's own name does
    let zip = dir + "/" + zipName(version: version)
    if names.contains(zipName(version: version)), isPlain(zip, directory: false), seam.isQuarantined(zip) { found.append(Candidate(path: zip)) }
    return found
  }

  /// A real file or folder at the path itself: a link (even to a good copy) never counts.
  static func isPlain(_ path: String, directory: Bool) -> Bool {
    var st = stat()
    guard lstat(path, &st) == 0 else { return false }
    let kind = st.st_mode & S_IFMT
    return directory ? kind == S_IFDIR : kind == S_IFREG
  }

  static func samePlace(_ a: String, _ b: String) -> Bool {
    (realpath(a, nil).map { p -> String in defer { free(p) }; return String(cString: p) }) == (realpath(b, nil).map { p -> String in defer { free(p) }; return String(cString: p) })
  }

  public enum Result: Equatable, Sendable {
    case nothingToDo
    case asked(trashed: [String], failed: [String])
    case kept
  }

  /// The first launch from ~/Applications after a move. `ask` shows the question and calls `answer` once with the owner's choice
  /// (a second call is ignored). The marker is cleared at the answer, before anything is trashed, so a crash never asks twice.
  public static func offer(
    defaults: UserDefaults, downloads: String, mine: BundleFacts, minePath: String, now: Date = Date(), seam: Seam,
    ask: (_ candidates: [Candidate], _ answer: @escaping (Bool) -> Void) -> Void, report: @escaping (String) -> Void,
    done: @escaping (Result) -> Void = { _ in }
  ) {
    guard let m = MoveMarker.read(defaults: defaults) else { return done(.nothingToDo) }
    let age = now.timeIntervalSince(m.movedAt)
    guard m.bundleID == mine.bundleID, m.version == mine.shortVersion, m.build == mine.buildVersion, age <= MoveMarker.maxAge else {
      MoveMarker.clear(defaults: defaults)
      return done(.nothingToDo)
    }
    let list = candidates(downloads: downloads, mine: mine, minePath: minePath, seam: seam)
    guard !list.isEmpty else {
      MoveMarker.clear(defaults: defaults)
      return done(.nothingToDo)
    }
    var answered = false
    ask(list) { yes in
      guard !answered else { return }
      answered = true
      MoveMarker.clear(defaults: defaults)
      guard yes else { return done(.kept) }
      var gone: [String] = []
      var failed: [String] = []
      for c in list {
        // judged again at the moment of the click: the copy may have been opened, swapped or turned into a link since the panel came up
        let still = candidates(downloads: downloads, mine: mine, minePath: minePath, seam: seam).contains(c)
        if still, seam.trash(c.path) { gone.append(c.name) } else { failed.append(c.name) }
      }
      if !failed.isEmpty { report(DownloadTidyCopy.failed(failed)) }
      done(.asked(trashed: gone, failed: failed))
    }
  }

  /// The real checks: the download flag on the item itself, and the Trash (`trashItem`).
  public static func liveSeam(isRunning: @escaping (String) -> Bool) -> Seam {
    Seam(
      isQuarantined: { getxattr($0, "com.apple.quarantine", nil, 0, 0, XATTR_NOFOLLOW) >= 0 },
      isRunning: isRunning,
      trash: { (try? FileManager.default.trashItem(at: URL(fileURLWithPath: $0), resultingItemURL: nil)) != nil })
  }
}

/// When the tidy panel may appear and when its buttons may be pressed. It shares the top-right corner with the Allow updates panel, so
/// it waits for that panel (and the setup window) to be gone, and ignores a click in its first second (one meant for what was there before).
public enum DownloadTidyGate {
  /// Same as `CloneConfirmCenter.clickDelay`.
  public static let clickDelay: TimeInterval = 1

  public static func blocked(allowUpdatesUp: Bool, onboardingUp: Bool) -> Bool { allowUpdatesUp || onboardingUp }

  /// Calls `show` once, the first time `blocked` is false; until then asks `retryLater` to call this again.
  public static func whenClear(blocked: @escaping () -> Bool, retryLater: @escaping (@escaping () -> Void) -> Void, show: @escaping () -> Void) {
    if blocked() { retryLater { whenClear(blocked: blocked, retryLater: retryLater, show: show) } } else { show() }
  }

  /// A click is taken only `clickDelay` after the panel appeared. `now` is monotonic seconds (`systemUptime`): a clock change never
  /// shortens or lengthens the wait.
  public struct Settle: Sendable {
    public let shownAt: TimeInterval
    public init(shownAt: TimeInterval) { self.shownAt = shownAt }
    public func accepts(now: TimeInterval) -> Bool { now - shownAt >= DownloadTidyGate.clickDelay }
  }
}
