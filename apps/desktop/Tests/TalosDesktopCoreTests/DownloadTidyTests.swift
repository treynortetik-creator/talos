import Foundation
import Testing
import TalosTestSupport

@testable import TalosDesktopCore

/// A real temp folder stands in for the owner's home. The real disk holds the items, the download flag is a real xattr, and only the
/// Trash (a folder in the same temp root) is stood in for.
private final class Yard: @unchecked Sendable {
  let root: String
  let downloads: String
  let neighbour: String
  let trashDir: String
  let defaults: UserDefaults
  let suite: String
  var running: Set<String> = []
  var trashed: [String] = []
  var reports: [String] = []
  var failTrash = false

  init() throws {
    root = try TestTemp.real(TestTemp.base) + "/talos-mover-tidy-" + UUID().uuidString.prefix(8)
    downloads = root + "/home/alex/Downloads"
    neighbour = root + "/home/alex/Documents"
    trashDir = root + "/Trash"
    for d in [downloads, neighbour, trashDir, downloads + "/sub"] { try FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true) }
    suite = "talos-tidy-test-" + UUID().uuidString.prefix(8)
    defaults = UserDefaults(suiteName: suite)!
  }
  func cleanUp() {
    try? FileManager.default.removeItem(atPath: root)
    defaults.removePersistentDomain(forName: suite)
  }

  let mine = BundleFacts(bundleID: AppMover.bundleID, shortVersion: "0.1.8", buildVersion: "108", hasCheckoutStamp: false, team: "T", running: true)
  let minePath = "/home/alex/Applications/Talos.app"

  @discardableResult
  func app(_ path: String, id: String? = AppMover.bundleID, short: String = "0.1.8", build: String = "108", quarantine: Bool = true) throws -> String {
    try FileManager.default.createDirectory(atPath: path + "/Contents", withIntermediateDirectories: true)
    var d: [String: Any] = ["CFBundleShortVersionString": short, "CFBundleVersion": build]
    if let id { d["CFBundleIdentifier"] = id }
    try (d as NSDictionary).write(to: URL(fileURLWithPath: path + "/Contents/Info.plist"))
    if quarantine { flag(path) }
    return path
  }
  func zip(_ name: String, quarantine: Bool = true) throws -> String {
    let p = downloads + "/" + name
    try Data("zip".utf8).write(to: URL(fileURLWithPath: p))
    if quarantine { flag(p) }
    return p
  }
  func flag(_ p: String) {
    let v = "0083;5fb7a1c0;Safari;"
    _ = v.withCString { setxattr(p, "com.apple.quarantine", $0, strlen($0), 0, XATTR_NOFOLLOW) }
  }
  func exists(_ p: String) -> Bool { (try? FileManager.default.destinationOfSymbolicLink(atPath: p)) != nil || FileManager.default.fileExists(atPath: p) }

  func seam() -> DownloadTidy.Seam {
    var s = DownloadTidy.liveSeam(isRunning: { self.running.contains($0) })
    s.trash = { p in
      if self.failTrash { return false }
      self.trashed.append(p)
      return (try? FileManager.default.moveItem(atPath: p, toPath: self.trashDir + "/" + UUID().uuidString.prefix(6) + "-" + (p as NSString).lastPathComponent)) != nil
    }
    return s
  }

  func marker(_ f: BundleFacts? = nil, at: Date = Date()) { MoveMarker.record(f ?? mine, defaults: defaults, now: at) }

  /// Runs the offer; `answer` is what the owner clicks (nil: never answers). Returns what was asked and the result.
  func run(answer: Bool?, now: Date = Date(), facts: BundleFacts? = nil) -> (asked: [String], result: DownloadTidy.Result?) {
    var asked: [String] = []
    var result: DownloadTidy.Result?
    DownloadTidy.offer(
      defaults: defaults, downloads: downloads, mine: facts ?? mine, minePath: minePath, now: now, seam: seam(),
      ask: { c, reply in
        asked = c.map(\.name)
        if let answer { reply(answer) }
      }, report: { self.reports.append($0) }, done: { result = $0 })
    return (asked, result)
  }
}

@Suite("Tidy the downloaded copy after a move", .serialized)
struct DownloadTidyTests {
  @Test func theSameVersionWithTheDownloadFlagIsOfferedAndTrashedOnYes() throws {
    let y = try Yard()
    defer { y.cleanUp() }
    try y.app(y.downloads + "/Talos.app")
    y.marker()
    let r = y.run(answer: true)
    #expect(r.asked == ["Talos.app"])
    #expect(r.result == .asked(trashed: ["Talos.app"], failed: []))
    #expect(!y.exists(y.downloads + "/Talos.app"))
    #expect(try FileManager.default.contentsOfDirectory(atPath: y.trashDir).count == 1)
    #expect(MoveMarker.read(defaults: y.defaults) == nil)
  }

  @Test func keepItLeavesBothAndStillClearsTheMarker() throws {
    let y = try Yard()
    defer { y.cleanUp() }
    try y.app(y.downloads + "/Talos.app")
    _ = try y.zip("Talos-0.1.8-universal.zip")
    y.marker()
    let r = y.run(answer: false)
    #expect(r.asked == ["Talos.app", "Talos-0.1.8-universal.zip"])
    #expect(r.result == .kept)
    #expect(y.trashed.isEmpty)
    #expect(y.exists(y.downloads + "/Talos.app"))
    #expect(MoveMarker.read(defaults: y.defaults) == nil, "asked once per move")
    #expect(y.run(answer: true).asked.isEmpty, "a second launch asks nothing")
  }

  @Test func aNewerOlderOrOtherBuildIsNeverOffered() throws {
    for (s, b) in [("0.1.9", "109"), ("0.1.7", "107"), ("0.1.8", "109"), ("0.1.8", "107"), ("0.1.9", "108"), ("0.1.7", "108")] {
      let y = try Yard()
      defer { y.cleanUp() }
      try y.app(y.downloads + "/Talos.app", short: s, build: b)
      y.marker()
      let r = y.run(answer: true)
      #expect(r.asked.isEmpty, "\(s) \(b)")
      #expect(r.result == .nothingToDo)
      #expect(y.exists(y.downloads + "/Talos.app"))
    }
  }

  @Test func aCopyWithoutTheDownloadFlagIsNeverOffered() throws {
    let y = try Yard()
    defer { y.cleanUp() }
    try y.app(y.downloads + "/Talos.app", quarantine: false)
    y.marker()
    #expect(y.run(answer: true).asked.isEmpty)
    #expect(y.exists(y.downloads + "/Talos.app"))
  }

  @Test func anotherBundleIdIsNeverOffered() throws {
    let y = try Yard()
    defer { y.cleanUp() }
    try y.app(y.downloads + "/Talos.app", id: "com.example.other")
    y.marker()
    #expect(y.run(answer: true).asked.isEmpty)
    let z = try Yard()
    defer { z.cleanUp() }
    try z.app(z.downloads + "/Talos.app", id: nil)
    z.marker()
    #expect(z.run(answer: true).asked.isEmpty)
  }

  @Test func aSymlinkIsNeverOfferedEvenToAGoodCopy() throws {
    let y = try Yard()
    defer { y.cleanUp() }
    let real = try y.app(y.neighbour + "/Talos.app")
    try FileManager.default.createSymbolicLink(atPath: y.downloads + "/Talos.app", withDestinationPath: real)
    let z = try y.zip("x.zip")
    try FileManager.default.createSymbolicLink(atPath: y.downloads + "/Talos-0.1.8-universal.zip", withDestinationPath: z)
    y.marker()
    #expect(y.run(answer: true).asked.isEmpty)
    #expect(y.exists(real), "the target of the link is untouched")
  }

  @Test func aRunningCopyIsNeverOffered() throws {
    let y = try Yard()
    defer { y.cleanUp() }
    let p = try y.app(y.downloads + "/Talos.app")
    y.running = [p]
    y.marker()
    #expect(y.run(answer: true).asked.isEmpty)
    #expect(y.exists(p))
  }

  @Test func theRunningAppItselfIsNeverOffered() throws {
    let y = try Yard()
    defer { y.cleanUp() }
    let p = try y.app(y.downloads + "/Talos.app")
    y.marker()
    var asked = false
    DownloadTidy.offer(
      defaults: y.defaults, downloads: y.downloads, mine: y.mine, minePath: p, seam: y.seam(), ask: { _, _ in asked = true }, report: { _ in })
    #expect(!asked)
  }

  @Test func theZipQualifiesOnlyByTheRunningVersionsExactName() throws {
    let y = try Yard()
    defer { y.cleanUp() }
    for n in ["Talos-0.1.7-universal.zip", "Talos-0.1.9-universal.zip", "Talos-0.1.8-universal.zip.bak", "Talos-0.1.8.zip", "Talos-0.1.80-universal.zip", "talos-0.1.8-universal.zip"] {
      _ = try y.zip(n)
    }
    _ = try y.zip("Talos-0.1.8-universal (1).zip")
    y.marker()
    #expect(y.run(answer: true).asked.isEmpty)
    let z = try Yard()
    defer { z.cleanUp() }
    _ = try z.zip("Talos-0.1.8-universal.zip")
    z.marker()
    let r = z.run(answer: true)
    #expect(r.asked == ["Talos-0.1.8-universal.zip"])
    #expect(r.result == .asked(trashed: ["Talos-0.1.8-universal.zip"], failed: []))
    #expect(!z.exists(z.downloads + "/Talos-0.1.8-universal.zip"))
  }

  @Test func aZipWithoutTheFlagOrAFolderOfThatNameIsLeftAlone() throws {
    let y = try Yard()
    defer { y.cleanUp() }
    _ = try y.zip("Talos-0.1.8-universal.zip", quarantine: false)
    y.marker()
    #expect(y.run(answer: true).asked.isEmpty)
    let z = try Yard()
    defer { z.cleanUp() }
    try FileManager.default.createDirectory(atPath: z.downloads + "/Talos-0.1.8-universal.zip", withIntermediateDirectories: true)
    z.flag(z.downloads + "/Talos-0.1.8-universal.zip")
    z.marker()
    #expect(z.run(answer: true).asked.isEmpty)
  }

  @Test func onlyTheTopLevelOfTheGivenFolderIsLookedAtAndNothingElseIsTouched() throws {
    let y = try Yard()
    defer { y.cleanUp() }
    try y.app(y.downloads + "/sub/Talos.app")  // one level down: not looked at
    try y.app(y.neighbour + "/Talos.app")  // another folder: not looked at
    _ = try y.zip("keep-me.txt", quarantine: true)
    try y.app(y.downloads + "/Talos.app")
    y.marker()
    let before = try listing(y.root).filter { !$0.hasPrefix("home/alex/Downloads/Talos.app") && !$0.hasPrefix("Trash") }
    let r = y.run(answer: true)
    #expect(r.asked == ["Talos.app"])
    #expect(y.trashed == [y.downloads + "/Talos.app"], "the only path handed to the Trash")
    let after = try listing(y.root).filter { !$0.hasPrefix("home/alex/Downloads/Talos.app") && !$0.hasPrefix("Trash") }
    #expect(before == after)
  }

  @Test func aTrashThatFailsIsReportedNotSkipped() throws {
    let y = try Yard()
    defer { y.cleanUp() }
    try y.app(y.downloads + "/Talos.app")
    y.marker()
    y.failTrash = true
    let r = y.run(answer: true)
    #expect(r.result == .asked(trashed: [], failed: ["Talos.app"]))
    #expect(y.reports == [DownloadTidyCopy.failed(["Talos.app"])])
    #expect(y.exists(y.downloads + "/Talos.app"))
  }

  @Test func aCopyThatBecomesALinkOrRunsWhilePanelIsUpIsNotTrashed() throws {
    let y = try Yard()
    defer { y.cleanUp() }
    let p = try y.app(y.downloads + "/Talos.app")
    y.marker()
    var answerLater: ((Bool) -> Void)?
    DownloadTidy.offer(
      defaults: y.defaults, downloads: y.downloads, mine: y.mine, minePath: y.minePath, seam: y.seam(),
      ask: { _, reply in answerLater = reply }, report: { y.reports.append($0) })
    y.running = [p]
    answerLater?(true)
    #expect(y.trashed.isEmpty)
    #expect(y.exists(p))
    #expect(y.reports.count == 1)
  }

  @Test func theMarkerClearsWithNothingToAskAndWhenStaleOrForAnotherVersion() throws {
    let y = try Yard()
    defer { y.cleanUp() }
    y.marker()
    #expect(y.run(answer: true).result == .nothingToDo)
    #expect(MoveMarker.read(defaults: y.defaults) == nil, "no candidate: cleared")
    try y.app(y.downloads + "/Talos.app")
    y.marker(at: Date().addingTimeInterval(-15 * 24 * 3600))
    #expect(y.run(answer: true).asked.isEmpty)
    #expect(MoveMarker.read(defaults: y.defaults) == nil, "stale: cleared")
    var other = y.mine
    other.shortVersion = "0.1.7"
    y.marker(other)
    #expect(y.run(answer: true).asked.isEmpty)
    #expect(MoveMarker.read(defaults: y.defaults) == nil, "another version moved: cleared")
    #expect(y.exists(y.downloads + "/Talos.app"))
  }

  @Test func withoutAMarkerNothingIsAskedOrTouched() throws {
    let y = try Yard()
    defer { y.cleanUp() }
    try y.app(y.downloads + "/Talos.app")
    let r = y.run(answer: true)
    #expect(r.asked.isEmpty)
    #expect(r.result == .nothingToDo)
    #expect(y.exists(y.downloads + "/Talos.app"))
  }

  @Test func theQuestionAnswersOnceAndTheMoveRecordsTheMarker() throws {
    let y = try Yard()
    defer { y.cleanUp() }
    try y.app(y.downloads + "/Talos.app")
    y.marker()
    var n = 0
    DownloadTidy.offer(
      defaults: y.defaults, downloads: y.downloads, mine: y.mine, minePath: y.minePath, seam: y.seam(),
      ask: { _, reply in reply(true); reply(true); reply(false) }, report: { _ in }, done: { _ in n += 1 })
    #expect(n == 1)
    #expect(y.trashed.count == 1)

    let z = try Yard()
    defer { z.cleanUp() }
    let r = AppMoveOffer.run(
      bundlePath: z.downloads + "/Talos.app", home: z.root + "/home/alex", isRelease: true, declinedBefore: false, otherInstanceRunning: false,
      ask: { _ in true }, move: { _ in .moved(to: z.root + "/home/alex/Applications/Talos.app", originalTrashed: false) },
      relaunch: { _ in #expect(MoveMarker.read(defaults: z.defaults) != nil, "recorded before the relaunch") }, activateOther: {},
      rememberDecline: {}, report: { _, _ in }, recordMoved: { MoveMarker.record(z.mine, defaults: z.defaults) })
    #expect(r == .moved(z.root + "/home/alex/Applications/Talos.app"))
    #expect(MoveMarker.read(defaults: z.defaults)?.version == "0.1.8")
  }

  private func listing(_ root: String) throws -> [String] {
    (FileManager.default.subpaths(atPath: root) ?? []).sorted()
  }
}

@Suite("Tidy panel waits and settles")
struct DownloadTidyGateTests {
  @Test func aClickInTheFirstSecondIsIgnoredAndALaterOneIsTaken() {
    let s = DownloadTidyGate.Settle(shownAt: 100)
    #expect(!s.accepts(now: 100))
    #expect(!s.accepts(now: 100.99))
    #expect(!s.accepts(now: 99), "a clock reading before it appeared")
    #expect(s.accepts(now: 101))
    #expect(DownloadTidyGate.clickDelay == 1)
  }

  @Test func theBlockRuleCoversAllowUpdatesAndSetup() {
    #expect(DownloadTidyGate.blocked(allowUpdatesUp: true, onboardingUp: false))
    #expect(DownloadTidyGate.blocked(allowUpdatesUp: false, onboardingUp: true))
    #expect(!DownloadTidyGate.blocked(allowUpdatesUp: false, onboardingUp: false))
  }

  @Test func theTidyPanelWaitsWhileAllowUpdatesIsUpAndShowsOnceAfter() {
    var allowUp = true
    var pending: [() -> Void] = []
    var shown = 0
    DownloadTidyGate.whenClear(
      blocked: { DownloadTidyGate.blocked(allowUpdatesUp: allowUp, onboardingUp: false) },
      retryLater: { pending.append($0) }, show: { shown += 1 })
    #expect(shown == 0 && pending.count == 1)
    pending.removeFirst()()  // still up
    #expect(shown == 0 && pending.count == 1)
    allowUp = false
    pending.removeFirst()()
    #expect(shown == 1 && pending.isEmpty)
  }
}
