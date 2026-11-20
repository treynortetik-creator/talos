import Foundation
import Testing
import TalosTestSupport

@testable import TalosDesktopCore

/// A real temp folder standing in for the owner's home: ~/Downloads, ~/Applications and a private Trash. The real disk does every
/// copy, move and rename; only the Trash, the signing team and "is it running" are stood in for (the real Trash is the owner's).
private final class World: @unchecked Sendable {
  let root: String
  let home: String
  let trashDir: String
  var teams: [String: String] = [:]
  var running: Set<String> = []
  var failRename = false
  var failCopy = false
  var failStrip = false
  /// Runs while the download flag is being cleared, between the modes being loosened and being put back.
  var duringStrip: ((String) -> Void)?
  var trashCount = 0
  let mineTeam = "TEAM123456"

  init() throws {
    root = ((TestTemp.base as NSString).appendingPathComponent("talos-mover-" + UUID().uuidString.prefix(8)) as NSString).standardizingPath
    home = root + "/home/alex"
    trashDir = root + "/Trash"
    for d in [home + "/Downloads", trashDir] { try FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true) }
  }
  func cleanUp() { try? FileManager.default.removeItem(atPath: root) }

  @discardableResult
  func app(
    _ path: String, id: String? = AppMover.bundleID, short: String = "0.1.8", build: String = "108", checkout: Bool = false, team: String? = "TEAM123456",
    marker: String = "x"
  ) throws -> String {
    try FileManager.default.createDirectory(atPath: path + "/Contents/MacOS", withIntermediateDirectories: true)
    var d: [String: Any] = ["CFBundleShortVersionString": short, "CFBundleVersion": build]
    if let id { d["CFBundleIdentifier"] = id }
    if checkout { d["TalosCheckout"] = "/home/alex/talos-app" }
    try (d as NSDictionary).write(to: URL(fileURLWithPath: path + "/Contents/Info.plist"))
    try Data(marker.utf8).write(to: URL(fileURLWithPath: path + "/Contents/MacOS/marker"))
    teams[path] = team
    return path
  }

  func marker(_ path: String) -> String? { (try? String(contentsOfFile: path + "/Contents/MacOS/marker", encoding: .utf8)) }
  func trashed() -> [String] { ((try? FileManager.default.contentsOfDirectory(atPath: trashDir)) ?? []).sorted() }

  func seam() -> AppMover.Seam {
    var s = AppMover.liveSeam(
      runTool: { args in
        if self.failStrip { return false }
        self.duringStrip?(args.last ?? "")
        let p = Process()
        p.executableURL = URL(fileURLWithPath: args[0])
        p.arguments = Array(args.dropFirst())
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return false }
        p.waitUntilExit()
        return p.terminationStatus == 0
      },
      team: { self.teams[$0] ?? self.teams[($0 as NSString).standardizingPath] }, isRunning: { self.running.contains($0) },
      trash: { p in
        self.trashCount += 1
        let to = self.trashDir + "/\((p as NSString).lastPathComponent)-\(self.trashCount)"
        return (try? FileManager.default.moveItem(atPath: p, toPath: to)) != nil ? to : nil
      })
    let copy = s.copy
    s.copy = { a, b in
      if self.failCopy { throw CocoaError(.fileWriteOutOfSpace) }
      try copy(a, b)
      self.teams[b] = self.teams[a]
    }
    let rename = s.rename
    s.rename = { a, b in
      if self.failRename { throw CocoaError(.fileWriteNoPermission) }
      try rename(a, b)
      self.teams[b] = self.teams[a]
    }
    return s
  }
}

@Suite("Move Talos to ~/Applications", .serialized)
struct AppMoverTests {
  /// The new copy is 0.1.8; the destination's is what each test sets.
  private func fresh() throws -> (World, String, String, String) {
    let w = try World()
    let src = try w.app(w.home + "/Downloads/Talos.app", marker: "new")
    let dest = w.home + "/Applications/Talos.app"
    return (w, src, dest, w.home + "/Applications")
  }

  @Test func theDestinationIsOnlyTheOwnersApplicationsFolderAndItIsMadeWhenMissing() throws {
    let (w, src, dest, dir) = try fresh()
    defer { w.cleanUp() }
    #expect(!FileManager.default.fileExists(atPath: dir))
    let r = AppMover.move(from: src, home: w.home, seam: w.seam(), tag: "a1")
    #expect(r == .moved(to: dest, originalTrashed: true))
    #expect(w.marker(dest) == "new")
    #expect(!FileManager.default.fileExists(atPath: dir + "/.Talos-moving-a1.app"), "no hidden half copy is left")
    #expect(!FileManager.default.fileExists(atPath: "/Applications/.Talos-moving-a1.app"), "never /Applications")
    #expect(w.trashed() == ["Talos.app-1"], "the downloaded copy went to the Trash")
  }

  @Test func theCopyHasNoDownloadFlagLeftAndAFlagThatCannotBeClearedStopsTheMove() throws {
    let (w, src, dest, _) = try fresh()
    defer { w.cleanUp() }
    w.failStrip = true
    let r = AppMover.move(from: src, home: w.home, seam: w.seam(), tag: "a2")
    guard case .failed = r else { Issue.record("expected a failure, got \(r)"); return }
    #expect(!FileManager.default.fileExists(atPath: dest) && w.marker(src) == "new", "nothing at the destination, the original kept")
    #expect(w.trashed().isEmpty)
  }

  @Test func aTranslocatedSourceIsMovedAndItsTemporaryPathIsNotTrashed() throws {
    let w = try World()
    defer { w.cleanUp() }
    let src = try w.app(w.root + "/var/T/AppTranslocation/8A0F1C52-6D2B-4F0E-9B1E-3F5A7C9D2E10/d/Talos.app", marker: "new")
    let r = AppMover.move(from: src, home: w.home, seam: w.seam(), tag: "a3")
    #expect(r == .moved(to: w.home + "/Applications/Talos.app", originalTrashed: false))
    #expect(w.trashed().isEmpty)
  }

  /// The clean-VM failure: the bundle ships a few files 0444 and macOS refuses to clear the download flag on a file its owner can't write.
  @Test func aReadOnlyFileCarryingTheDownloadFlagMovesAndTheOriginalIsUntouched() throws {
    let (w, src, dest, _) = try fresh()
    defer { w.cleanUp() }
    let rel = "/Contents/Resources/talos-hooks"
    try FileManager.default.createDirectory(atPath: src + rel, withIntermediateDirectories: true)
    let ro = src + rel + "/hook.py"
    try Data("# hook".utf8).write(to: URL(fileURLWithPath: ro))
    // the flag first (a write), then the file goes read-only, as the build leaves it
    try runX(["-w", "com.apple.quarantine", "0083;00000000;Safari;", ro])
    chmod(ro, 0o444)
    chmod(src + rel, 0o755)
    // control: the real tool refuses on the read-only file, so this test fails if the mover stops handling it
    #expect(!(runXOk(["-d", "com.apple.quarantine", ro])), "control: xattr refuses a 0444 file")
    let r = AppMover.move(from: src, home: w.home, seam: w.seam(), tag: "p1")
    #expect(r == .moved(to: dest, originalTrashed: true))
    let moved = dest + rel + "/hook.py"
    #expect(!runXOk(["-p", "com.apple.quarantine", moved]), "the copy has no download flag")
    var st = stat(); stat(moved, &st)
    #expect(st.st_mode & 0o777 == 0o444, "the mode is put back: the app refuses a writable hook")
    // the original went to the Trash whole: its flag and mode are as they were
    let trashed = w.trashDir + "/Talos.app-1" + rel + "/hook.py"
    var ost = stat(); stat(trashed, &ost)
    #expect(ost.st_mode & 0o777 == 0o444 && runXOk(["-p", "com.apple.quarantine", trashed]), "the original is untouched")
  }

  /// A mode that cannot be put back is a failed move, not a success with a writable hook: the copy is deleted.
  @Test func aModeThatCannotBeRestoredFailsTheMoveAndDeletesTheCopy() throws {
    let (w, src, dest, dir) = try fresh()
    defer { w.cleanUp() }
    let ro = src + "/Contents/MacOS/ro.py"
    try Data("x".utf8).write(to: URL(fileURLWithPath: ro))
    chmod(ro, 0o444)
    // the file is swapped out while its mode is loosened, so the mode can't be put back (a real failed restore)
    w.duringStrip = { copy in try? FileManager.default.removeItem(atPath: copy + "/Contents/MacOS/ro.py") }
    let s = w.seam()
    let r = AppMover.move(from: src, home: w.home, seam: s, tag: "p3")
    guard case .failed = r else { Issue.record("expected a failure, got \(r)"); return }
    #expect(!FileManager.default.fileExists(atPath: dest), "nothing at the destination")
    #expect(((try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []).isEmpty, "the copy is deleted")
    #expect(FileManager.default.fileExists(atPath: src), "the original is kept")
  }

  /// Signing stays intact: a real ad hoc signed bundle with a read-only resource still verifies, deep and strict, after the move.
  @Test func aSignedBundleStillVerifiesAfterTheMove() throws {
    let (w, src, dest, _) = try fresh()
    defer { w.cleanUp() }
    try FileManager.default.createDirectory(atPath: src + "/Contents/Resources", withIntermediateDirectories: true)
    let ro = src + "/Contents/Resources/claude-install.sh"
    try Data("#!/bin/sh\n".utf8).write(to: URL(fileURLWithPath: ro))
    let exe = src + "/Contents/MacOS/Talos"
    try FileManager.default.copyItem(atPath: "/usr/bin/true", toPath: exe)
    var d = try #require(PropertyListSerialization.propertyList(from: Data(contentsOf: URL(fileURLWithPath: src + "/Contents/Info.plist")), format: nil) as? [String: Any])
    d["CFBundleExecutable"] = "Talos"
    try (d as NSDictionary).write(to: URL(fileURLWithPath: src + "/Contents/Info.plist"))
    try FileManager.default.removeItem(atPath: src + "/Contents/MacOS/marker")
    chmod(ro, 0o444)
    guard runTool("/usr/bin/codesign", ["--force", "--sign", "-", src]) else { Issue.record("could not sign the fixture"); return }
    #expect(runTool("/usr/bin/codesign", ["--verify", "--deep", "--strict", src]), "control: the fixture verifies")
    try runX(["-w", "com.apple.quarantine", "0083;00000000;Safari;", exe])
    let r = AppMover.move(from: src, home: w.home, seam: w.seam(), tag: "p2")
    #expect(r == .moved(to: dest, originalTrashed: true))
    #expect(runTool("/usr/bin/codesign", ["--verify", "--deep", "--strict", dest]), "the copy still verifies")
  }

  @Test func aFailedCopyLeavesNothingBehind() throws {
    let (w, src, dest, dir) = try fresh()
    defer { w.cleanUp() }
    w.failCopy = true
    guard case .failed = AppMover.move(from: src, home: w.home, seam: w.seam(), tag: "a4") else { Issue.record("expected a failure"); return }
    #expect(!FileManager.default.fileExists(atPath: dest))
    #expect(((try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []).isEmpty)
  }

  // MARK: what is already at the destination (R1-2)

  @Test func aForeignAppCalledTalosIsNeverTouched() throws {
    let (w, src, dest, _) = try fresh()
    defer { w.cleanUp() }
    try w.app(dest, id: "com.example.talos-lookalike", short: "0.0.1", build: "1", marker: "foreign")
    #expect(AppMover.move(from: src, home: w.home, seam: w.seam(), tag: "b1") == .kept(at: dest, isTalos: false))
    #expect(w.marker(dest) == "foreign" && w.trashed().isEmpty && w.marker(src) == "new")
  }

  @Test func aNewerTalosIsNeverTouched() throws {
    let (w, src, dest, _) = try fresh()
    defer { w.cleanUp() }
    try w.app(dest, short: "0.2.0", build: "200", marker: "newer")
    #expect(AppMover.move(from: src, home: w.home, seam: w.seam(), tag: "b2") == .kept(at: dest, isTalos: true))
    #expect(w.marker(dest) == "newer" && w.trashed().isEmpty)
  }

  @Test func theSameVersionIsNeverTouched() throws {
    let (w, src, dest, _) = try fresh()
    defer { w.cleanUp() }
    try w.app(dest, marker: "same")
    #expect(AppMover.move(from: src, home: w.home, seam: w.seam(), tag: "b2b") == .kept(at: dest, isTalos: true))
    #expect(w.marker(dest) == "same")
  }

  @Test func aRunningOlderTalosIsNeverTouched() throws {
    let (w, src, dest, _) = try fresh()
    defer { w.cleanUp() }
    try w.app(dest, short: "0.1.5", build: "105", marker: "running")
    w.running = [dest]
    #expect(AppMover.move(from: src, home: w.home, seam: w.seam(), tag: "b3") == .kept(at: dest, isTalos: true))
    #expect(w.marker(dest) == "running" && w.trashed().isEmpty)
  }

  @Test func aSourceBuiltTalosFromInstallShIsNeverTouchedEvenWhenOlder() throws {
    let (w, src, dest, _) = try fresh()
    defer { w.cleanUp() }
    try w.app(dest, short: "0.1.5", build: "105", checkout: true, marker: "mine")
    #expect(AppMover.move(from: src, home: w.home, seam: w.seam(), tag: "b4") == .kept(at: dest, isTalos: true))
    #expect(w.marker(dest) == "mine" && w.trashed().isEmpty)
  }

  @Test func anOlderTalosSignedByAnotherTeamOrNotSignedIsNeverTouched() throws {
    for team in ["OTHERTEAM1", nil] as [String?] {
      let (w, src, dest, _) = try fresh()
      defer { w.cleanUp() }
      try w.app(dest, short: "0.1.5", build: "105", team: team, marker: "theirs")
      #expect(AppMover.move(from: src, home: w.home, seam: w.seam(), tag: "b5") == .kept(at: dest, isTalos: true), Comment(rawValue: String(describing: team)))
      #expect(w.marker(dest) == "theirs" && w.trashed().isEmpty)
    }
  }

  @Test func aCopyWithNoSigningTeamOfItsOwnNeverReplacesAnything() throws {
    let (w, _, dest, _) = try fresh()
    defer { w.cleanUp() }
    let src = try w.app(w.home + "/Downloads/Other/Talos.app", team: nil, marker: "new")
    try w.app(dest, short: "0.1.5", build: "105", team: nil, marker: "old")
    #expect(AppMover.move(from: src, home: w.home, seam: w.seam(), tag: "b6") == .kept(at: dest, isTalos: true))
    #expect(w.marker(dest) == "old")
  }

  @Test func anUnreadableBundleAtTheDestinationIsLeftAlone() throws {
    let (w, src, dest, _) = try fresh()
    defer { w.cleanUp() }
    try FileManager.default.createDirectory(atPath: dest, withIntermediateDirectories: true)
    #expect(AppMover.move(from: src, home: w.home, seam: w.seam(), tag: "b7") == .kept(at: dest, isTalos: false))
    #expect(FileManager.default.fileExists(atPath: dest) && w.trashed().isEmpty)
  }

  @Test func anOlderStoppedReleaseTalosOfTheSameTeamGoesToTheTrashAndTheNewOneTakesItsPlace() throws {
    let (w, src, dest, _) = try fresh()
    defer { w.cleanUp() }
    try w.app(dest, short: "0.1.5", build: "105", marker: "old")
    #expect(AppMover.move(from: src, home: w.home, seam: w.seam(), tag: "c1") == .moved(to: dest, originalTrashed: true))
    #expect(w.marker(dest) == "new")
    #expect(w.trashed().compactMap { w.marker(w.trashDir + "/" + $0) }.sorted() == ["new", "old"], "the old one is recoverable in the Trash")
  }

  @Test func ifTheFinalRenameFailsAfterTheOldOneWasTrashedItIsPutBackAndSaid() throws {
    let (w, src, dest, dir) = try fresh()
    defer { w.cleanUp() }
    try w.app(dest, short: "0.1.5", build: "105", marker: "old")
    w.failRename = true
    let r = AppMover.move(from: src, home: w.home, seam: w.seam(), tag: "c2")
    guard case .failed(let why) = r else { Issue.record("expected a failure, got \(r)"); return }
    #expect(why.contains("put the older Talos back"), "\(why)")
    #expect(w.marker(dest) == "old", "the owner's Talos is back where it was")
    #expect(w.trashed().isEmpty && w.marker(src) == "new")
    #expect(((try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []) == ["Talos.app"], "no hidden half copy")
  }

  @Test func versionsCompareByNumberAndOnlyAClearlyOlderOneCounts() {
    func f(_ s: String?, _ b: String?) -> BundleFacts { BundleFacts(bundleID: AppMover.bundleID, shortVersion: s, buildVersion: b, hasCheckoutStamp: false, team: "T", running: false) }
    #expect(AppVersion.isOlder(f("0.1.9", "109"), than: f("0.1.10", "110")), "0.1.9 is older than 0.1.10, not newer as text would say")
    #expect(!AppVersion.isOlder(f("0.1.10", "110"), than: f("0.1.9", "109")))
    #expect(!AppVersion.isOlder(f("0.1.8", "108"), than: f("0.1.8", "108")))
    #expect(!AppVersion.isOlder(f("0.1.7", "200"), than: f("0.1.8", "108")), "older short version but a newer build: not clearly older")
    #expect(!AppVersion.isOlder(f(nil, "1"), than: f("0.1.8", "108")) && !AppVersion.isOlder(f("beta", "1"), than: f("0.1.8", "108")))
  }

  // MARK: the relaunch script, really run

  @Test func theRelaunchScriptOpensAPathWithSpacesAndQuotesExactlyOnce() throws {
    let w = try World()
    defer { w.cleanUp() }
    let tricky = w.root + "/It's a \"Talos\" folder; echo hacked/Talos $(touch pwned).app"
    try FileManager.default.createDirectory(atPath: tricky, withIntermediateDirectories: true)
    let log = w.root + "/opened.txt"
    let opener = w.root + "/fake-open.sh"
    try "#!/bin/sh\nprintf '%s\\n' \"$#\" \"$1\" >> \"\(log)\"\n".write(toFile: opener, atomically: true, encoding: .utf8)
    chmod(opener, 0o755)
    let gone = Process()  // a process that has already ended: the script must not wait for it
    gone.executableURL = URL(fileURLWithPath: "/usr/bin/true")
    try gone.run(); gone.waitUntilExit()
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/sh")
    p.arguments = AppRelaunch.arguments(pid: gone.processIdentifier, app: tricky, opener: opener, settle: "0")
    try p.run(); p.waitUntilExit()
    #expect(p.terminationStatus == 0)
    #expect(try String(contentsOfFile: log, encoding: .utf8) == "1\n\(tricky)\n", "one argument, the whole path, unchanged")
    #expect(!FileManager.default.fileExists(atPath: w.root + "/pwned") && !FileManager.default.fileExists(atPath: "pwned"), "the path is data, never shell code")
  }

  @Test func theRelaunchScriptWaitsWhileThisAppIsStillRunning() throws {
    let w = try World()
    defer { w.cleanUp() }
    let log = w.root + "/opened.txt"
    let opener = w.root + "/fake-open.sh"
    try "#!/bin/sh\necho \"$1\" >> \"\(log)\"\n".write(toFile: opener, atomically: true, encoding: .utf8)
    chmod(opener, 0o755)
    let alive = Process()
    alive.executableURL = URL(fileURLWithPath: "/bin/sleep")
    alive.arguments = ["3"]
    try alive.run()
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/sh")
    p.arguments = AppRelaunch.arguments(pid: alive.processIdentifier, app: w.root + "/Talos.app", opener: opener, settle: "0")
    try p.run()
    Thread.sleep(forTimeInterval: 0.8)
    #expect(!FileManager.default.fileExists(atPath: log), "nothing is opened while the first Talos still runs")
    alive.terminate(); alive.waitUntilExit(); p.waitUntilExit()
    #expect(FileManager.default.fileExists(atPath: log))
  }
}

@Suite("The move question at launch")
struct AppMoveOfferTests {
  let id = "8A0F1C52-6D2B-4F0E-9B1E-3F5A7C9D2E10"
  final class Calls {
    var asked: [AppLocation.Reason] = []; var moves: [String] = []; var relaunched: [String] = []; var declines = 0
    var reports: [(String, String)] = []; var activated = 0
  }

  func run(
    _ path: String, release: Bool = true, declined: Bool = false, answer: Bool = true, other: Bool = false,
    outcome: AppMover.Outcome = .moved(to: "/home/alex/Applications/Talos.app", originalTrashed: true), _ c: Calls
  ) -> AppMoveOffer.Result {
    AppMoveOffer.run(
      bundlePath: path, home: "/home/alex", isRelease: release, declinedBefore: declined, otherInstanceRunning: other,
      ask: { c.asked.append($0); return answer }, move: { c.moves.append($0); return outcome }, relaunch: { c.relaunched.append($0) },
      activateOther: { c.activated += 1 }, rememberDecline: { c.declines += 1 }, report: { c.reports.append(($0, $1)) })
  }

  @Test func theRightPlaceAsksNothingAndMovesNothing() {
    let c = Calls()
    #expect(run("/home/alex/Applications/Talos.app", c) == .notNeeded)
    #expect(c.asked.isEmpty && c.moves.isEmpty)
    #expect(run("/home/alex/Downloads/Talos.app", release: false, c) == .notNeeded)
  }

  @Test func theSystemApplicationsFolderNeedsAMoveWithWordsThatExplainWhy() {
    let c = Calls()
    #expect(run("/Applications/Talos.app", c) == .moved("/home/alex/Applications/Talos.app"))
    #expect(c.asked == [.systemApplications])
    #expect(AppMoveCopy.body(.systemApplications).contains("update itself"))
    #expect(AppMoveCopy.body(.systemApplications) != AppMoveCopy.body(.elsewhere))
  }

  @Test func yesMovesThenOpensTheNewCopy() {
    let c = Calls()
    #expect(run("/home/alex/Downloads/Talos.app", c) == .moved("/home/alex/Applications/Talos.app"))
    #expect(c.asked == [.elsewhere] && c.moves == ["/home/alex/Downloads/Talos.app"] && c.relaunched == ["/home/alex/Applications/Talos.app"])
  }

  @Test func anotherRunningTalosIsBroughtForwardWithNoQuestionAndNoMove() {
    let c = Calls()
    #expect(run("/home/alex/Downloads/Talos.app", other: true, c) == .otherRunning)
    #expect(c.activated == 1 && c.asked.isEmpty && c.moves.isEmpty && c.relaunched.isEmpty)
    // a copy already in the right place never looks for the other one: it is not part of this
    #expect(run("/home/alex/Applications/Talos.app", other: true, Calls()) == .notNeeded)
  }

  @Test func doNotMoveIsRememberedForARegularCopyAndNeverAskedAgain() {
    let c = Calls()
    #expect(run("/home/alex/Downloads/Talos.app", answer: false, c) == .declined)
    #expect(c.declines == 1 && c.moves.isEmpty && c.relaunched.isEmpty)
    let c2 = Calls()
    #expect(run("/home/alex/Downloads/Talos.app", declined: true, c2) == .declined)
    #expect(c2.asked.isEmpty)
  }

  @Test func aTemporaryCopyIsAskedEveryTimeBecauseItCannotUpdate() {
    let p = "/private/var/folders/xy/abc/T/AppTranslocation/\(id)/d/Talos.app"
    let c = Calls()
    #expect(run(p, declined: true, answer: false, c) == .declined)
    #expect(c.asked == [.temporary] && c.declines == 0)
  }

  @Test func aFailedMoveIsReportedAndNothingRelaunches() {
    let c = Calls()
    #expect(run("/home/alex/Downloads/Talos.app", outcome: .failed("Talos may not write to /home/alex/Applications."), c) == .failed("Talos may not write to /home/alex/Applications."))
    #expect(c.reports.count == 1 && c.reports[0].0 == AppMoveCopy.failedTitle && c.reports[0].1.contains("may not write") && c.relaunched.isEmpty)
  }

  @Test func aTalosAlreadyThereIsLeftAloneSaidPlainlyAndUsed() {
    let c = Calls()
    let at = "/home/alex/Applications/Talos.app"
    #expect(run("/home/alex/Downloads/Talos.app", outcome: .kept(at: at, isTalos: true), c) == .kept(at))
    #expect(c.reports.map { $0.1 } == ["There's already a Talos in your Applications folder. Talos will keep using that one."])
    #expect(c.relaunched == [at], "the one that is there is the one that opens")
  }

  @Test func aForeignAppThereIsLeftAloneAndNeverOpenedAsIfItWereTalos() {
    let c = Calls()
    #expect(run("/home/alex/Downloads/Talos.app", outcome: .kept(at: "/home/alex/Applications/Talos.app", isTalos: false), c) == .kept("/home/alex/Applications/Talos.app"))
    #expect(c.relaunched.isEmpty && c.reports.count == 1)
  }

  @Test func theQuestionsWordsAreAllPlain() {
    for s in AppMoveCopy.all + [AppMoveCopy.failed("x")] { #expect(OnboardingCopy.forbiddenWords(in: s).isEmpty, Comment(rawValue: s)) }
    #expect(AppMoveCopy.move == "Move to Applications folder" && AppMoveCopy.doNotMove == "Do Not Move")
  }
}

private func runTool(_ exe: String, _ args: [String]) -> Bool {
  let p = Process()
  p.executableURL = URL(fileURLWithPath: exe)
  p.arguments = args
  p.standardOutput = FileHandle.nullDevice
  p.standardError = FileHandle.nullDevice
  do { try p.run() } catch { return false }
  p.waitUntilExit()
  return p.terminationStatus == 0
}
private func runXOk(_ args: [String]) -> Bool { runTool("/usr/bin/xattr", args) }
private func runX(_ args: [String]) throws {
  struct Failed: Error {}
  if !runXOk(args) { throw Failed() }
}
