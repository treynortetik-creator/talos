import CryptoKit
import Foundation
import Testing
import TalosDesktopCore
import TalosTestSupport

@testable import TalosSupervisor

/// A prebuilt app on a Mac with no checkout record: the app fetches the public repository at its own release tag, installs the
/// packages and records the clone. REAL git against a local bare repository that stands in for GitHub (a file:// address, allowed
/// only by the test's own config), a per-test HOME, a stub installer inside the fixture repo and a stub pnpm. No network.
@Suite("Auto clone: a fresh Mac", .serialized, .enabled(if: AutoCloneWorld.git != nil))
struct CloneProvisionerTests {
  @Test func aFreshMacClonesTheAppsOwnTagNotMainInstallsAndRecords() throws {
    let w = try AutoCloneWorld()
    defer { w.cleanUp() }
    let steps = StepLog()
    let r = w.provisioner().run { s, st in steps.add(s, st) }
    guard case .ok(let clone) = r else { Issue.record("expected ok, got \(r)"); return }
    #expect(clone == w.dest, "a fixed place under the bundle-id folder")
    // the tag's code, not main's
    #expect(FileManager.default.fileExists(atPath: clone + "/install.sh"))
    #expect(!FileManager.default.fileExists(atPath: clone + "/main-only.txt"), "main is ahead of the tag; the clone must not have it")
    #expect(try w.git(["-C", clone, "rev-parse", "HEAD"]) == w.tagSha)
    // dependencies went through the clone's own installer check and pnpm, in the clone
    let pnpm = try String(contentsOfFile: w.home + "/pnpm.log", encoding: .utf8)
    #expect(pnpm.contains("install --frozen-lockfile") && pnpm.contains("cwd=\(clone)"), "\(pnpm)")
    #expect(try String(contentsOfFile: w.home + "/installer.log", encoding: .utf8).contains("--dry-run --no-app --yes"))
    // the record: new folder, mode 0600, read back by the app's own reader and accepted by its own judge
    let rec = AutoSetup.appFolder(home: w.home) + "/checkout"
    #expect(try String(contentsOfFile: rec, encoding: .utf8) == clone + "\n")
    var st = stat(); lstat(rec, &st)
    #expect(st.st_mode & 0o777 == 0o600)
    #expect(AgentFolderSetup.recordedCheckout(in: AutoSetup.recordFolders(home: w.home))?.clone == clone)
    #expect(AgentFolderSetup.recordedCloneProblem(clone, recordFile: rec, unsafe: [w.home + "/.talos-app", w.home + "/talos-agent"]) == nil)
    // every step ran in order and ended done
    #expect(steps.states(.record) == [.running, .done])
    #expect(CloneProvisioner.Step.allCases.allSatisfy { steps.states($0).last == .done })
    #expect(steps.order == CloneProvisioner.Step.allCases)
    #expect(w.leftovers().isEmpty, "no staging folder is left: \(w.leftovers())")
    // git ran the way it must: full path, no prompt, no user config, the https-only allow list
    let log = try String(contentsOfFile: w.home + "/git.log", encoding: .utf8)
    #expect(log.contains("GIT_TERMINAL_PROMPT=0") && log.contains("GIT_CONFIG_GLOBAL=/dev/null"), "\(log)")
    #expect(!log.contains("GIT_DIR="), "a GIT_DIR from the owner's shell never reaches git")
    #expect(log.contains("protocol.allow=never"), "\(log)")
  }

  @Test func aSecondRunReusesTheCloneAndDoesNotCloneAgain() throws {
    let w = try AutoCloneWorld()
    defer { w.cleanUp() }
    #expect(w.provisioner().run() == .ok(clone: w.dest))
    #expect(w.provisioner().run() == .ok(clone: w.dest))
    #expect(w.gitCalls(containing: " clone ") == 1)
  }

  @Test func aTagThatDoesNotExistFailsAtTheLookupAndKeepsNothing() throws {
    let w = try AutoCloneWorld(version: "9.9.9")
    defer { w.cleanUp() }
    let r = w.provisioner().run()
    guard case .failed(let step, let why) = r else { Issue.record("expected a failure, got \(r)"); return }
    #expect(step == .lookup && why.contains("mac-v9.9.9") && why.contains("no release"), "\(why)")
    #expect(!FileManager.default.fileExists(atPath: w.dest) && w.leftovers().isEmpty)
    #expect(!FileManager.default.fileExists(atPath: AutoSetup.appFolder(home: w.home) + "/checkout"), "no record without a clone")
    #expect(w.gitCalls(containing: " clone ") == 0)
  }

  @Test func aBuildWithNoReleaseNumberCannotPickATag() throws {
    for v in [nil, "", "dev", "0.1.4-dirty", "0.1.4 ", "-x", "0.1.4;rm", "../x", "v0.1.4"] as [String?] {
      #expect(CloneProvisioner.tag(forVersion: v) == nil, "\(String(describing: v))")
    }
    #expect(CloneProvisioner.tag(forVersion: "0.1.4") == "mac-v0.1.4")
    let w = try AutoCloneWorld(version: "dev")
    defer { w.cleanUp() }
    guard case .failed(.lookup, let why) = w.provisioner().run() else { Issue.record("expected a lookup failure"); return }
    #expect(why.contains("no release number") && why.contains("Choose"), "\(why)")
    #expect(w.gitCalls(containing: "") == 0, "git was never run")
  }

  @Test func anUnreachableRepositoryFailsClearlyAndKeepsNothing() throws {
    let w = try AutoCloneWorld()
    defer { w.cleanUp() }
    guard case .failed(.lookup, let why) = w.provisioner({ $0.repoURL = "file://" + w.home + "/no-such-repo" }).run() else { Issue.record("expected a lookup failure"); return }
    #expect(why.contains("couldn't reach") && why.contains("Nothing was changed"), "\(why)")
    #expect(!FileManager.default.fileExists(atPath: w.dest) && w.leftovers().isEmpty)
  }

  @Test func aCloneThatFailsAfterTheLookupLeavesNoStagingFolderAndNoRecord() throws {
    let w = try AutoCloneWorld()
    defer { w.cleanUp() }
    FileManager.default.createFile(atPath: w.home + "/fail-clone", contents: Data())
    guard case .failed(.clone, let why) = w.provisioner().run() else { Issue.record("expected a clone failure"); return }
    #expect(why.contains("download failed") && why.contains("fatal: simulated network drop") && why.contains("Nothing was kept"), "\(why)")
    #expect(!FileManager.default.fileExists(atPath: w.dest) && w.leftovers().isEmpty)
    #expect(!FileManager.default.fileExists(atPath: AutoSetup.appFolder(home: w.home) + "/checkout"))
    // and a retry once the network is back works
    try FileManager.default.removeItem(atPath: w.home + "/fail-clone")
    #expect(w.provisioner().run() == .ok(clone: w.dest))
  }

  @Test func onlyHttpsIsAcceptedAndGitIsNeverRunForAnythingElse() throws {
    for bad in [
      "http://example.com/x/y", "ssh://git@example.com/x/y", "git@example.com:x/y.git", "git://example.com/x/y", "ext::sh -c id",
      "file:///tmp/x", "https://user:pw@example.com/x/y", "https:///x",
    ] {
      let w = try AutoCloneWorld(url: bad, schemes: ["https"])
      defer { w.cleanUp() }
      guard case .failed(.lookup, let why) = w.provisioner().run() else { Issue.record("\(bad) was not refused"); continue }
      #expect(why.contains("not an https address") || why.contains("not a plain https address"), "\(bad): \(why)")
      #expect(w.gitCalls(containing: "") == 0, "\(bad): git ran")
    }
    #expect(CloneProvisioner.publicRepo.hasPrefix("https://"))
    #expect(CloneProvisioner.Config(version: "0.1.4", destination: "/x/y", recordFile: "/x/c", git: nil, pnpm: nil, env: [:]).allowedSchemes == ["https"])
  }

  @Test func missingPrerequisitesAreListedTheCloneIsKeptAndNothingIsRecorded() throws {
    let w = try AutoCloneWorld(env: ["STUB_PREREQ": "1"])
    defer { w.cleanUp() }
    guard case .failed(.prerequisites, let why) = w.provisioner().run() else { Issue.record("expected a prerequisites failure"); return }
    #expect(why.contains("bun: install Bun 1.4.4 or newer"), "\(why)")
    #expect(FileManager.default.fileExists(atPath: w.dest + "/install.sh"), "the download is kept for the retry")
    #expect(!FileManager.default.fileExists(atPath: AutoSetup.appFolder(home: w.home) + "/checkout"))
    #expect(!FileManager.default.fileExists(atPath: w.home + "/pnpm.log"), "no packages before the prerequisites pass")
  }

  @Test func aFailedPackageInstallStopsBeforeTheRecord() throws {
    let w = try AutoCloneWorld(env: ["STUB_PNPM_FAIL": "1"])
    defer { w.cleanUp() }
    guard case .failed(.dependencies, let why) = w.provisioner().run() else { Issue.record("expected a dependencies failure"); return }
    #expect(why.contains("ERR_PNPM_STUB") && why.contains("press Retry"), "\(why)")
    #expect(!FileManager.default.fileExists(atPath: AutoSetup.appFolder(home: w.home) + "/checkout"))
  }

  @Test func aFolderAlreadyAtTheDestinationIsNeverDeleted() throws {
    let w = try AutoCloneWorld()
    defer { w.cleanUp() }
    try FileManager.default.createDirectory(atPath: w.dest, withIntermediateDirectories: true)
    FileManager.default.createFile(atPath: w.dest + "/mine.txt", contents: Data("keep".utf8))
    guard case .failed(.clone, let why) = w.provisioner().run() else { Issue.record("expected a clone failure"); return }
    #expect(why.contains("does not delete") && why.contains(w.dest), "\(why)")
    #expect(try String(contentsOfFile: w.dest + "/mine.txt", encoding: .utf8) == "keep")
  }

  @Test func twoRunsAtOnceHaveOneCloneAndBothEndWell() throws {
    let w = try AutoCloneWorld()
    defer { w.cleanUp() }
    let results = ResultsBox()
    DispatchQueue.concurrentPerform(iterations: 2) { _ in results.add(w.provisioner().run()) }
    #expect(results.all.count == 2 && results.all.allSatisfy { $0 == .ok(clone: w.dest) }, "\(results.all)")
    #expect(w.leftovers().isEmpty, "\(w.leftovers())")
    #expect(try w.git(["-C", w.dest, "rev-parse", "HEAD"]) == w.tagSha)
  }

  @Test func theNewRecordWinsOverTheOldAndTheOldIsReadWhenTheNewIsMissingOrEmpty() throws {
    let w = try AutoCloneWorld()
    defer { w.cleanUp() }
    let dirs = AutoSetup.recordFolders(home: w.home)
    #expect(AgentFolderSetup.recordedCheckout(in: dirs) == nil, "a fresh Mac has no record")
    func put(_ dir: String, _ text: String) throws {
      try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
      FileManager.default.createFile(atPath: dir + "/checkout", contents: Data(text.utf8))
    }
    try put(dirs[1], "/home/alex/old-clone\n")
    #expect(AgentFolderSetup.recordedCheckout(in: dirs)?.clone == "/home/alex/old-clone")
    #expect(AgentFolderSetup.recordedCheckout(in: dirs)?.file == dirs[1] + "/checkout", "judged by the file it came from")
    try put(dirs[0], "\n")
    #expect(AgentFolderSetup.recordedCheckout(in: dirs)?.clone == "/home/alex/old-clone", "an empty new record falls back")
    try put(dirs[0], "/home/alex/new-clone\n")
    #expect(AgentFolderSetup.recordedCheckout(in: dirs)?.clone == "/home/alex/new-clone", "new wins")
    #expect(AgentFolderSetup.recordedCheckout(in: dirs)?.file == dirs[0] + "/checkout")
  }

  @Test func theFreshInstallDefaultsAreOnOnlyForAFreshInstallAndNeverOverrideAChoice() {
    let name = "talos-autoclone-defaults-\(UUID().uuidString)"
    let d = UserDefaults(suiteName: name)!
    defer { d.removePersistentDomain(forName: name) }
    AutoSetup.seedFreshInstall(d, isFresh: false)
    #expect(d.object(forKey: "companion.enabled") == nil && d.object(forKey: "showDockIcon") == nil, "an existing install is left alone")
    d.set(false, forKey: "showDockIcon")
    AutoSetup.seedFreshInstall(d, isFresh: true)
    #expect(d.bool(forKey: "companion.enabled") && !d.bool(forKey: "showDockIcon"), "on where unset, a choice kept")
    #expect(AutoSetup.defaultAgentDir == "~/talos-agent")
  }

  // MARK: the code is pinned by the signed app

  @Test func aTagThatNamesAnotherCommitThanTheAppWasReleasedFromIsRefused() throws {
    let w = try AutoCloneWorld()
    defer { w.cleanUp() }
    let other = String(repeating: "b", count: 40)
    guard case .failed(.lookup, let why) = w.provisioner({ $0.expectedCommit = other }).run() else { Issue.record("expected a lookup failure"); return }
    #expect(why.contains("was released from") && why.contains("did not download"), "\(why)")
    #expect(w.gitCalls(containing: " clone ") == 0 && !FileManager.default.fileExists(atPath: w.dest))
    #expect(!FileManager.default.fileExists(atPath: AutoSetup.appFolder(home: w.home) + "/checkout"))
    // the stamped commit equal to the tag's: it goes through (the happy path of every other test)
    #expect(w.provisioner({ $0.expectedCommit = w.tagSha }).run() == .ok(clone: w.dest))
  }

  @Test func aBuildWithNoStampedCommitRefusesToFetchCodeByItself() throws {
    let w = try AutoCloneWorld()
    defer { w.cleanUp() }
    for bad in [nil, "", "abc", String(repeating: "Z", count: 40)] as [String?] {
      guard case .failed(.lookup, let why) = w.provisioner({ $0.expectedCommit = bad }).run() else { Issue.record("\(String(describing: bad)) was accepted"); continue }
      #expect(why.contains("no release commit stamped") && why.contains("Choose"), "\(why)")
    }
    #expect(w.gitCalls(containing: " clone ") == 0)
  }

  @Test func aClonedHeadThatIsNotTheStampedCommitIsRefused() throws {
    // the tag moves between the lookup and the clone: the clone's HEAD is checked against what the lookup said, which was the stamp
    let w = try AutoCloneWorld()
    defer { w.cleanUp() }
    // a folder already at the destination that is a clone of ANOTHER commit is not reused
    _ = try w.git(["clone", "-q", "--branch", "main", w.remote, w.dest])
    guard case .failed(.clone, let why) = w.provisioner().run() else { Issue.record("expected a clone failure"); return }
    #expect(why.contains("not a whole copy of mac-v0.1.4"), "\(why)")
  }

  // MARK: the release's own source tarball: the primary route

  @Test func theFirstSetupDownloadsTheReleasesOwnTarballChecksItsHashAndNeverRunsGit() throws {
    let w = try AutoCloneWorld()  // git and the developer tools ARE there: the tarball is still the route
    defer { w.cleanUp() }
    let steps = StepLog()
    let r = w.provisioner({ w.viaArchive(&$0) }).run { s, st in steps.add(s, st) }
    #expect(r == .ok(clone: w.dest), "\(r)")
    #expect(w.gitCalls(containing: " clone ") == 0 && w.gitCalls(containing: " ls-remote ") == 0, "no git clone or lookup: the tarball is the source")
    // a git checkout of the stamped commit, clean, and a repository of its own: what the updater's gate asks of it
    #expect(try w.git(["-C", w.dest, "rev-parse", "HEAD"]) == w.tagSha)
    #expect(try w.git(["-C", w.dest, "rev-parse", "--show-toplevel"]) == w.dest)
    #expect(try w.git(["-C", w.dest, "status", "--porcelain", "--ignored"]) == "")
    #expect(try w.git(["-C", w.dest, "remote", "get-url", "origin"]) == w.url)
    #expect(FileManager.default.fileExists(atPath: w.dest + "/install.sh"))
    #expect(!FileManager.default.fileExists(atPath: w.dest + "/main-only.txt"), "the tag's code")
    // git archive's group-writable modes are tightened: the app's own judge accepts the copy
    let rec = AutoSetup.appFolder(home: w.home) + "/checkout"
    #expect(AgentFolderSetup.recordedCloneProblem(w.dest, recordFile: rec, unsafe: [w.home + "/.talos-app"]) == nil)
    #expect(CloneProvisioner.Step.allCases.allSatisfy { steps.states($0).last == .done })
    #expect(w.leftovers().isEmpty, "\(w.leftovers())")
    #expect(w.provisioner({ w.viaArchive(&$0) }).run() == .ok(clone: w.dest), "a second run reuses it")
  }

  @Test func aTarballWithAnExtraOrChangedFileIsRefusedAtTheStatusCheckEvenWithItsOwnMatchingHash() throws {
    let w = try AutoCloneWorld()
    defer { w.cleanUp() }
    // an asset that someone altered AND whose hash was stamped to match: the hash passes, the commit's own tree does not
    for (label, change) in [("an extra file", "echo evil > talos-0.1.4/extra.txt"), ("a changed file", "echo '# changed' >> talos-0.1.4/install.sh")] {
      let work = w.home + "/tamper"
      try? FileManager.default.removeItem(atPath: work)
      try FileManager.default.createDirectory(atPath: work, withIntermediateDirectories: true)
      let src = w.home + "/release/mac-v0.1.4/talos-source-mac-v0.1.4.tar.gz"
      let r = ProcessRunner.run(["/bin/sh", "-c", "/usr/bin/tar -xzf \"$1\" -C \"$2\" && cd \"$2\" && \(change) && /usr/bin/tar -czf ../altered.tar.gz talos-0.1.4", "sh", src, work], timeout: 60)
      #expect(r.ok, "\(r.err)")
      try FileManager.default.createDirectory(atPath: w.home + "/altered/mac-v0.1.4", withIntermediateDirectories: true)
      try? FileManager.default.removeItem(atPath: w.home + "/altered/mac-v0.1.4/talos-source-mac-v0.1.4.tar.gz")
      try FileManager.default.moveItem(atPath: w.home + "/altered.tar.gz", toPath: w.home + "/altered/mac-v0.1.4/talos-source-mac-v0.1.4.tar.gz")
      let sum = ProcessRunner.run(["/usr/bin/shasum", "-a", "256", w.home + "/altered/mac-v0.1.4/talos-source-mac-v0.1.4.tar.gz"], timeout: 30)
      let altered = sum.out.split(separator: " ").first.map(String.init) ?? ""
      let result = w.provisioner({ c in w.viaArchive(&c); c.expectedSourceSHA256 = altered; c.sourceBase = "file://" + w.home + "/altered" }).run()
      guard case .failed(.clone, let why) = result else { Issue.record("\(label): expected a clone failure, got \(result)"); continue }
      #expect(why.contains("not exactly the release's commit") && why.contains("Nothing was kept"), "\(label): \(why)")
      #expect(!FileManager.default.fileExists(atPath: w.dest) && w.leftovers().isEmpty, "\(label): nothing kept")
    }
  }

  @Test func aTarballWhoseHashIsNotTheStampedOneIsNeverUnpacked() throws {
    let w = try AutoCloneWorld()
    defer { w.cleanUp() }
    // a swapped asset: another archive under the right name
    let asset = w.home + "/release/mac-v0.1.4/talos-source-mac-v0.1.4.tar.gz"
    try FileManager.default.removeItem(atPath: asset)
    FileManager.default.createFile(atPath: asset, contents: Data("not the release".utf8))
    guard case .failed(.clone, let why) = w.provisioner({ w.viaArchive(&$0) }).run() else { Issue.record("expected a clone failure"); return }
    #expect(why.contains("its checksum differs") && why.contains("did not unpack") && why.contains("Nothing was kept"), "\(why)")
    #expect(!FileManager.default.fileExists(atPath: w.dest) && w.leftovers().isEmpty)
    #expect(!FileManager.default.fileExists(atPath: AutoSetup.appFolder(home: w.home) + "/checkout"))
    // a stamped value that is not a hash is refused before anything is fetched
    guard case .failed(.lookup, let why2) = w.provisioner({ w.viaArchive(&$0); $0.expectedSourceSHA256 = "xyz" }).run() else { Issue.record("expected a lookup failure"); return }
    #expect(why2.contains("not a SHA-256"), "\(why2)")
  }

  @Test func aMissingTarballFailsClearlyAndTheArchiveRouteIsHttpsOnlyInProduction() throws {
    let w = try AutoCloneWorld()
    defer { w.cleanUp() }
    guard case .failed(.clone, let why) = w.provisioner({ w.viaArchive(&$0); $0.sourceBase = "file://" + w.home + "/nowhere" }).run() else {
      Issue.record("expected a clone failure"); return
    }
    #expect(why.contains("download of Talos's code failed") && why.contains("Nothing was kept"), "\(why)")
    guard case .failed(.clone, let why2) = w.provisioner({ w.viaArchive(&$0); $0.allowedSchemes = ["https"]; $0.repoURL = CloneProvisioner.publicRepo }).run() else {
      Issue.record("expected a clone failure"); return
    }
    #expect(why2.contains("not an https address"), "\(why2)")
    #expect(CloneProvisioner.publicReleases.hasPrefix("https://"))
    #expect(!FileManager.default.fileExists(atPath: w.dest) && w.leftovers().isEmpty)
  }

  @Test func aFolderThatIsNotThisReleasesCopyIsNotReusedOnTheArchiveRoute() throws {
    let w = try AutoCloneWorld()
    defer { w.cleanUp() }
    try FileManager.default.createDirectory(atPath: w.dest, withIntermediateDirectories: true)
    FileManager.default.createFile(atPath: w.dest + "/.talos-commit", contents: Data((String(repeating: "c", count: 40) + "\n").utf8))
    guard case .failed(.clone, let why) = w.provisioner({ w.viaArchive(&$0) }).run() else { Issue.record("expected a clone failure"); return }
    #expect(why.contains("does not delete"), "\(why)")
  }

  // MARK: the updater trusts only an accepted clone

  @Test func theUpdaterRunsARecordedCloneOnlyWhenItsPathWasAccepted() throws {
    let w = try AutoCloneWorld()
    defer { w.cleanUp() }
    #expect(w.provisioner().run() == .ok(clone: w.dest))
    let rec = AutoSetup.appFolder(home: w.home) + "/checkout"
    let record = (clone: w.dest, file: rec)
    let unsafe = [w.home + "/.talos-app", w.home + "/talos-agent"]
    #expect(AgentFolderSetup.updaterCheckout(stamped: nil, record: record, accepted: w.dest, unsafe: unsafe) == w.dest, "accepted and sound: used")
    #expect(AgentFolderSetup.updaterCheckout(stamped: nil, record: record, accepted: nil, unsafe: unsafe) == nil, "never accepted: not moved or run")
    #expect(AgentFolderSetup.updaterCheckout(stamped: nil, record: record, accepted: "/home/alex/other-clone", unsafe: unsafe) == nil, "another path was accepted")
    #expect(AgentFolderSetup.updaterCheckout(stamped: nil, record: nil, accepted: w.dest, unsafe: unsafe) == nil, "no record")
    #expect(AgentFolderSetup.updaterCheckout(stamped: nil, record: record, accepted: w.dest, unsafe: [w.home + "/Library"]) == nil, "accepted but in a session folder")
    #expect(AgentFolderSetup.updaterCheckout(stamped: "/home/alex/build-clone", record: record, accepted: nil, unsafe: unsafe) == "/home/alex/build-clone", "a local build's stamped clone")
  }

  // MARK: one fetch at a time

  @Test func twoCallersWhileAFetchRunsShareOneRunAndTheNextCallStartsAfresh() async throws {
    let flight = SingleFlight<Int>()
    let runs = LookCounter()
    let gate = LookCounter()  // each signal lets one run finish
    let finished = LookCounter()
    let work: @Sendable () async -> Int = {
      let n = runs.bump()
      while gate.value <= finished.value { try? await Task.sleep(nanoseconds: 1_000_000) }
      _ = finished.bump()
      return n
    }
    async let first = flight.run(work)
    while !flight.isRunning { try await Task.sleep(nanoseconds: 1_000_000) }
    async let second = flight.run(work)  // while the first is still running
    try await Task.sleep(nanoseconds: 50_000_000)
    _ = gate.bump()
    let (a, b) = await (first, second)
    #expect(a == 1 && b == 1 && runs.bump() == 2, "one run served both (\(a), \(b))")
    _ = gate.bump()
    #expect(await flight.run(work) == 3, "after it ended, a new call runs again")
    #expect(!flight.isRunning)
  }

  // MARK: packages: bun when there is no pnpm

  @Test func withNoPnpmThePackagesComeFromBunAndTheInstallerIsToldSo() throws {
    let w = try AutoCloneWorld(pnpm: false)
    defer { w.cleanUp() }
    #expect(w.provisioner().run() == .ok(clone: w.dest))
    let bun = try String(contentsOfFile: w.home + "/bun.log", encoding: .utf8)
    #expect(bun.contains("install --frozen-lockfile --ignore-scripts") && bun.contains("cwd=\(w.dest)") && bun.contains("hooks=1"), "\(bun)")
    #expect(!FileManager.default.fileExists(atPath: w.home + "/pnpm.log"))
    let inst = try String(contentsOfFile: w.home + "/installer.log", encoding: .utf8)
    #expect(inst.contains("js=bun") && inst.contains("hooks=1"), "the clone's installer is told to use bun and to skip git hooks: \(inst)")
  }

  @Test func aFailedBunInstallStopsBeforeTheRecord() throws {
    let w = try AutoCloneWorld(env: ["STUB_BUN_FAIL": "1"], pnpm: false)
    defer { w.cleanUp() }
    guard case .failed(.dependencies, let why) = w.provisioner().run() else { Issue.record("expected a dependencies failure"); return }
    #expect(why.contains("simulated bun failure"), "\(why)")
    #expect(!FileManager.default.fileExists(atPath: AutoSetup.appFolder(home: w.home) + "/checkout"))
  }

  // MARK: Claude Code: the pinned installer, only when claude is missing

  @Test func aMissingClaudeRunsThePinnedInstallerWithItsVersionAndNoTerminal() throws {
    let w = try AutoCloneWorld()
    defer { w.cleanUp() }
    let script = try w.claudeScript()
    let steps = StepLog()
    let r = w.provisioner({ c in
      c.claudeFound = { FileManager.default.isExecutableFile(atPath: w.home + "/.local/bin/claude") }
      c.claudeInstaller = w.installer(script)
    }).run { s, st in steps.add(s, st) }
    #expect(r == .ok(clone: w.dest), "\(r)")
    let log = try String(contentsOfFile: w.home + "/claude-install.log", encoding: .utf8)
    #expect(log.contains("args=2.1.328") && log.contains("secret=") && !log.contains("secret=hunter2"), "the pinned version, no owner secrets: \(log)")
    #expect(steps.states(.claude) == [.running, .done])
    #expect(!FileManager.default.fileExists(atPath: w.home + "/curl.log"), "the installer script was not downloaded: the bundled copy ran")
    // already there: the installer is not run again
    try FileManager.default.removeItem(atPath: w.home + "/claude-install.log")
    #expect(w.provisioner({ c in
      c.claudeFound = { FileManager.default.isExecutableFile(atPath: w.home + "/.local/bin/claude") }
      c.claudeInstaller = w.installer(script)
    }).run() == .ok(clone: w.dest))
    #expect(!FileManager.default.fileExists(atPath: w.home + "/claude-install.log"))
  }

  @Test func aChangedInstallerScriptIsNeverRun() throws {
    let w = try AutoCloneWorld()
    defer { w.cleanUp() }
    let script = try w.claudeScript()
    var inst = w.installer(script)
    inst.sha256 = String(repeating: "0", count: 64)  // the bundled script is not the pinned one (tampered after signing)
    guard case .failed(.claude, let why) = w.provisioner({ c in c.claudeFound = { false }; c.claudeInstaller = inst }).run() else {
      Issue.record("expected a claude failure"); return
    }
    #expect(why.contains("not the one it was released with") && why.contains("claude.ai/code"), "\(why)")
    #expect(!FileManager.default.fileExists(atPath: w.home + "/claude-install.log"), "the script was not run")
    #expect(!FileManager.default.fileExists(atPath: AutoSetup.appFolder(home: w.home) + "/checkout"))
  }

  @Test func anInstallerThatFailsOrLeavesNoClaudeBehindIsReported() throws {
    let w = try AutoCloneWorld()
    defer { w.cleanUp() }
    let inst = w.installer(try w.claudeScript(fail: true))
    guard case .failed(.claude, let why) = w.provisioner({ c in c.claudeFound = { false }; c.claudeInstaller = inst }).run() else {
      Issue.record("expected a claude failure"); return
    }
    #expect(why.contains("Installing Claude Code failed") && why.contains("simulated installer failure") && why.contains("Retry"), "\(why)")
    // no installer configured at all: said, not skipped
    guard case .failed(.claude, let why2) = w.provisioner({ c in c.claudeFound = { false }; c.claudeInstaller = nil }).run() else {
      Issue.record("expected a claude failure"); return
    }
    #expect(why2.contains("Install it from https://claude.ai/code"), "\(why2)")
    // a build with no bundled script (a development build) says so and runs nothing
    #expect(ClaudeInstaller(env: [:], home: w.home, workDir: w.home, scriptPath: nil).run()?.contains("no Claude Code installer inside") == true)
    #expect(ClaudeInstaller.pinnedScriptSHA256.count == 64)
  }

  // MARK: the bundled bun and tmux

  @Test func theBundledFolderComesLastOnThePathSoAMacsOwnToolsWin() {
    #expect(BundledTools.appending(toPath: "/opt/homebrew/bin:/usr/bin", dir: "/home/alex/Talos.app/Contents/Helpers") == "/opt/homebrew/bin:/usr/bin:/home/alex/Talos.app/Contents/Helpers")
    #expect(BundledTools.appending(toPath: "/usr/bin:/home/alex/Talos.app/Contents/Helpers", dir: "/home/alex/Talos.app/Contents/Helpers") == "/usr/bin:/home/alex/Talos.app/Contents/Helpers", "not twice")
    #expect(BundledTools.appending(toPath: nil, dir: "/h")?.hasSuffix(":/h") == true && BundledTools.appending(toPath: "", dir: "/h")?.hasPrefix("/usr/bin") == true)
    #expect(BundledTools.appending(toPath: "/usr/bin", dir: nil) == "/usr/bin")
    // the env every agent and thread session gets (LoginShellEnv.build), and the owner's own PATH still wins
    let env = LoginShellEnv.build(shellEnv: ["PATH": "/usr/bin:/bin"], overrides: [:], bundledTools: "/h/Helpers")
    #expect(env["PATH"] == "/usr/bin:/bin:/h/Helpers")
    #expect(LoginShellEnv.build(shellEnv: ["PATH": "/usr/bin"], overrides: ["PATH": "/mine"], bundledTools: "/h/Helpers")["PATH"] == "/mine")
    #expect(LoginShellEnv.build(shellEnv: ["PATH": "/usr/bin"], overrides: [:], bundledTools: nil)["PATH"] == "/usr/bin", "a debug build adds nothing")
  }

  @Test func tmuxIsTakenFromTheMacFirstAndFromTheBundleOnlyWhenThereIsNone() {
    let bundled = "/h/Talos.app/Contents/Helpers"
    let have: Set<String> = [bundled + "/tmux"]
    #expect(TalosAppLocator.findTmux(envPath: "/usr/bin", home: "/h", bundled: bundled, isExecutable: { have.contains($0) }) == bundled + "/tmux")
    let both: Set<String> = [bundled + "/tmux", "/opt/homebrew/bin/tmux"]
    #expect(TalosAppLocator.findTmux(envPath: "/usr/bin", home: "/h", bundled: bundled, isExecutable: { both.contains($0) }) == "/opt/homebrew/bin/tmux")
    #expect(TalosAppLocator.findTmux(envPath: "/usr/bin", home: "/h", bundled: nil, isExecutable: { _ in false }) == nil)
    #expect(BundledTools.resolve(bundlePath: "/h/Talos.app", isExecutable: { $0 == "/h/Talos.app/Contents/Helpers/bun" }) == "/h/Talos.app/Contents/Helpers")
    #expect(BundledTools.resolve(bundlePath: "/h/Talos.app", isExecutable: { _ in false }) == nil, "an app with no helpers adds no folder")
  }

  @Test func theInstallerUsesBunOnlyWhenThereIsNoPnpm() {
    let withPnpm = BundledTools.jsRuntimeEnv(["PATH": "/p"], isExecutable: { $0 == "/p/pnpm" })
    #expect(withPnpm["TALOS_JS_RUNTIME"] == nil)
    let without = BundledTools.jsRuntimeEnv(["PATH": "/p", "TALOS_JS_RUNTIME": "x"], isExecutable: { _ in false })
    #expect(without["TALOS_JS_RUNTIME"] == "bun")
    #expect(BundledTools.jsRuntimeEnv(["PATH": "/p", "TALOS_JS_RUNTIME": "bun"], isExecutable: { $0 == "/p/pnpm" })["TALOS_JS_RUNTIME"] == nil)
  }

  // MARK: Apple's developer tools

  @Test func withNoDeveloperToolsMacosIsAskedOnceThePollWaitsAndNothingNeedingThemRunsFirst() throws {
    let w = try AutoCloneWorld(clt: false)
    defer { w.cleanUp() }
    let steps = StepLog()
    let r = w.provisioner().run { s, st in steps.add(s, st) }
    #expect(r == .ok(clone: w.dest), "\(r)")
    #expect(steps.states(.developerTools) == [.running, .waiting("One quick Apple install first: click Install when macOS asks (about 5 minutes)"), .done])
    #expect(AutoSetup.developerToolsPrompt == "One quick Apple install first: click Install when macOS asks (about 5 minutes)")
    let o = w.order()
    #expect(o.filter { $0 == "install" }.count == 1, "the install was asked for once: \(o)")
    let present = try #require(o.firstIndex(of: "present"))
    let firstGit = try #require(o.firstIndex(of: "git"))
    #expect(o.firstIndex(of: "install")! < present && present < firstGit, "git ran only after the tools were there: \(o)")
    #expect(steps.order.first == .developerTools)
  }

  @Test func closingAppleSInstallWindowIsAFailureWithTryAgainAndTryAgainAsksAgain() throws {
    let w = try AutoCloneWorld(clt: false)
    defer { w.cleanUp() }
    FileManager.default.createFile(atPath: w.home + "/clt-dismiss", contents: Data())
    let looks = LookCounter()
    let r = w.provisioner({ $0.installerRunning = { looks.bump() <= 2 } }).run()  // on screen twice, then gone
    guard case .failed(.developerTools, let why) = r else { Issue.record("expected a developer tools failure, got \(r)"); return }
    #expect(why.contains("closed") && why.contains("Try again") && why.contains("click Install"), "\(why)")
    #expect(w.order() == ["install"], "asked once, and no git or python: \(w.order())")
    #expect(!FileManager.default.fileExists(atPath: w.dest) && !FileManager.default.fileExists(atPath: w.home + "/git.log"))
    // Try again: the owner clicks Install this time
    try FileManager.default.removeItem(atPath: w.home + "/clt-dismiss")
    #expect(w.provisioner().run() == .ok(clone: w.dest))
    #expect(w.order().filter { $0 == "install" }.count == 2, "\(w.order())")
  }

  @Test func developerToolsThatNeverAppearEndInAClearFailureAtTheTimeout() throws {
    let w = try AutoCloneWorld(clt: false)
    defer { w.cleanUp() }
    FileManager.default.createFile(atPath: w.home + "/clt-dismiss", contents: Data())
    guard case .failed(.developerTools, let why) = w.provisioner({ $0.installerRunning = { false }; $0.toolsTimeout = 0.2 }).run() else {
      Issue.record("expected a developer tools failure"); return
    }
    #expect(why.contains("were not installed after") && why.contains("Try again"), "\(why)")
    #expect(!FileManager.default.fileExists(atPath: w.home + "/git.log"))
  }

  @Test func developerToolsAlreadyThereAreNeverInstalled() throws {
    let w = try AutoCloneWorld(clt: true)
    defer { w.cleanUp() }
    let steps = StepLog()
    #expect(w.provisioner().run { s, st in steps.add(s, st) } == .ok(clone: w.dest))
    #expect(!w.order().contains("install"), "xcode-select --install was never run: \(w.order())")
    #expect(steps.states(.developerTools) == [.running, .done])
  }
}

final class LookCounter: @unchecked Sendable {
  private let lock = NSLock()
  private var n = 0
  func bump() -> Int { lock.withLock { n += 1; return n } }
  var value: Int { lock.withLock { n } }
}

// MARK: world

final class StepLog: @unchecked Sendable {
  private let lock = NSLock()
  private var log: [(CloneProvisioner.Step, CloneProvisioner.State)] = []
  func add(_ s: CloneProvisioner.Step, _ st: CloneProvisioner.State) { lock.withLock { log.append((s, st)) } }
  func states(_ s: CloneProvisioner.Step) -> [CloneProvisioner.State] { lock.withLock { log.filter { $0.0 == s }.map(\.1) } }
  var order: [CloneProvisioner.Step] {
    lock.withLock { log.map(\.0).reduce(into: []) { if $0.last != $1 { $0.append($1) } } }
  }
}

final class ResultsBox: @unchecked Sendable {
  private let lock = NSLock()
  private var v: [CloneProvisioner.Result] = []
  func add(_ r: CloneProvisioner.Result) { lock.withLock { v.append(r) } }
  var all: [CloneProvisioner.Result] { lock.withLock { v } }
}

/// One test's Mac: a HOME, a bare repo standing in for GitHub (tag mac-v0.1.4 behind a main that has one more commit), a stub pnpm
/// and a git wrapper that logs what it was called with and its environment, and fails `clone` while `fail-clone` exists.
struct AutoCloneWorld {
  static let git: String? = CloneProvisioner.findGit(cltInstalled: CloneProvisioner.commandLineToolsInstalled(), isExecutable: FileManager.default.isExecutableFile)

  let home: String
  let remote: String
  let tagSha: String
  let dest: String
  let url: String
  let schemes: Set<String>
  let version: String
  let extraEnv: [String: String]
  let clt: Bool
  var sourceSha = ""
  let hasPnpm: Bool

  init(version: String = "0.1.4", url: String? = nil, schemes: Set<String> = ["file"], env: [String: String] = [:], clt: Bool = true, pnpm: Bool = true) throws {
    self.clt = clt
    hasPnpm = pnpm
    let base = try TestTemp.real(TestTemp.base)
    home = base + "talos-autoclone-" + UUID().uuidString
    try FileManager.default.createDirectory(atPath: home + "/bin", withIntermediateDirectories: true)
    self.version = version
    self.schemes = schemes
    extraEnv = env
    remote = home + "/remote.git"
    self.url = url ?? "file://" + remote
    dest = AutoSetup.cloneFolder(home: home)
    let real = Self.git!
    // the wrapper: log, then run the real git; `clone` fails while the marker file exists
    try Self.write(
      home + "/bin/git",
      """
      #!/bin/bash
      echo "git $*" >> "\(home)/git.log"; echo git >> "\(home)/order.log"
      env | grep '^GIT_' | sort >> "\(home)/git.log"
      case " $* " in *" clone "*) [ -e "\(home)/fail-clone" ] && { echo "fatal: simulated network drop" >&2; exit 128; } ;; esac
      exec "\(real)" "$@"
      """)
    try Self.write(
      home + "/bin/pnpm",
      """
      #!/bin/bash
      echo "$* cwd=$(pwd -P)" >> "\(home)/pnpm.log"
      [ -n "${STUB_PNPM_FAIL:-}" ] && { echo "ERR_PNPM_STUB simulated failure" >&2; exit 1; }
      exit 0
      """)
    // xcode-select: `-p` succeeds once `clt-present` exists; `--install` starts "installing", which finishes on the third look unless
    // `clt-dismiss` exists (the owner closed Apple's window). order.log records the install, the moment they appear, and every git call.
    if clt { FileManager.default.createFile(atPath: home + "/clt-present", contents: Data()) }
    try Self.write(
      home + "/bin/xcode-select",
      """
      #!/bin/bash
      case "$1" in
        -p) [ -e "\(home)/clt-present" ] && { echo /Library/Developer/CommandLineTools; exit 0; }
            if [ -e "\(home)/clt-installing" ] && [ ! -e "\(home)/clt-dismiss" ]; then
              n=$(cat "\(home)/clt-polls" 2>/dev/null || echo 0); n=$((n + 1)); echo $n > "\(home)/clt-polls"
              if [ $n -ge 3 ]; then touch "\(home)/clt-present"; echo present >> "\(home)/order.log"; echo /Library/Developer/CommandLineTools; exit 0; fi
            fi
            echo "xcode-select: error: unable to get active developer directory" >&2; exit 2 ;;
        --install) touch "\(home)/clt-installing"; echo install >> "\(home)/order.log" ;;
      esac
      """)
    // a curl that records any call: the Claude installer must run the copy inside the app and fetch nothing itself
    try Self.write(home + "/bin/curl", "#!/bin/bash\necho \"curl $*\" >> \"\(home)/curl.log\"\nexit 1\n")
    try Self.write(
      home + "/bin/bun",
      """
      #!/bin/bash
      echo "$* cwd=$(pwd -P) hooks=${TALOS_NO_HOOKS:-}" >> "\(home)/bun.log"
      [ -n "${STUB_BUN_FAIL:-}" ] && { echo "error: simulated bun failure" >&2; exit 1; }
      exit 0
      """)
    // the fixture repo: what install.sh, the bridge and the mod must be for `cloneProblem`, a stub installer, then main moves on
    let work = home + "/work"
    try FileManager.default.createDirectory(atPath: work + "/apps/bridge/src", withIntermediateDirectories: true)
    try FileManager.default.createDirectory(atPath: work + "/plugins/talos-app-mod", withIntermediateDirectories: true)
    try Self.write(
      work + "/install.sh",
      """
      #!/bin/bash
      echo "$* js=${TALOS_JS_RUNTIME:-} hooks=${TALOS_NO_HOOKS:-}" >> "\(home)/installer.log"
      [ -n "${STUB_PREREQ:-}" ] && { printf 'Cannot continue. Missing:\\n  - bun: install Bun 1.4.4 or newer: https://example.com/bun\\nInstall what is listed, then run ./install.sh again. Nothing was changed.\\n' >&2; exit 3; }
      exit 0
      """)
    try Self.write(work + "/apps/bridge/src/cli.ts", "")
    try Self.write(work + "/plugins/talos-app-mod/plugin.json", "{}")
    let fixed = [
      "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1", "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com",
      "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com", "HOME": home,
    ]
    func g(_ args: [String], in dir: String) throws -> String {
      let r = ProcessRunner.run([real] + args, env: fixed.merging(["PATH": "/usr/bin:/bin"]) { a, _ in a }, cwd: dir, timeout: 60)
      guard r.ok else { throw CocoaError(.fileWriteUnknown, userInfo: [NSLocalizedDescriptionKey: "git \(args): \(r.err)"]) }
      return r.out.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    _ = try g(["init", "-q", "-b", "main"], in: work)
    _ = try g(["add", "."], in: work)
    _ = try g(["commit", "-q", "-m", "release"], in: work)
    _ = try g(["tag", "-a", "mac-v0.1.4", "-m", "release 0.1.4"], in: work)
    tagSha = try g(["rev-parse", "HEAD"], in: work)
    try Self.write(work + "/main-only.txt", "newer")
    _ = try g(["add", "."], in: work)
    _ = try g(["commit", "-q", "-m", "after the release"], in: work)
    _ = try g(["clone", "-q", "--bare", work, remote], in: home)
    // the release's own source tarball, as release-app.sh makes it (git archive, gzip -n), and its sha256
    let assetDir = home + "/release/mac-v0.1.4"
    try FileManager.default.createDirectory(atPath: assetDir, withIntermediateDirectories: true)
    _ = try g(["archive", "--format=tar", "--prefix=talos-0.1.4/", "-o", home + "/release/src.tar", "mac-v0.1.4"], in: work)
    _ = ProcessRunner.run(["/usr/bin/gzip", "-n", "-9", home + "/release/src.tar"], timeout: 30)
    try FileManager.default.moveItem(atPath: home + "/release/src.tar.gz", toPath: assetDir + "/talos-source-mac-v0.1.4.tar.gz")
    let sum = ProcessRunner.run(["/usr/bin/shasum", "-a", "256", assetDir + "/talos-source-mac-v0.1.4.tar.gz"], timeout: 30)
    sourceSha = sum.out.split(separator: " ").first.map(String.init) ?? ""
  }

  func provisioner(_ tweak: (inout CloneProvisioner.Config) -> Void = { _ in }) -> CloneProvisioner {
    var env = ["PATH": home + "/bin:/usr/bin:/bin", "HOME": home, "GIT_DIR": "/nonexistent-from-the-owners-shell"]
    env.merge(extraEnv) { _, b in b }
    var c = CloneProvisioner.Config(
      version: version, destination: dest, recordFile: AutoSetup.appFolder(home: home) + "/checkout", git: nil,
      pnpm: hasPnpm ? home + "/bin/pnpm" : nil, env: env)
    c.xcodeSelect = home + "/bin/xcode-select"
    c.toolsPollInterval = 0.01
    c.toolsTimeout = 3
    let present = home + "/clt-present", installing = home + "/clt-installing"
    c.installerRunning = { FileManager.default.fileExists(atPath: installing) && !FileManager.default.fileExists(atPath: present) }
    c.findGit = { [wrapper = home + "/bin/git"] in wrapper }
    c.expectedCommit = tagSha
    c.bun = home + "/bin/bun"
    c.repoURL = url
    c.allowedSchemes = schemes
    c.gitTimeout = 60
    c.installTimeout = 60
    tweak(&c)
    return c.asProvisioner
  }

  func git(_ args: [String]) throws -> String {
    let r = ProcessRunner.run([Self.git!] + args, env: ["PATH": "/usr/bin:/bin", "HOME": home, "GIT_CONFIG_GLOBAL": "/dev/null"], timeout: 30)
    guard r.ok else { throw CocoaError(.fileReadUnknown, userInfo: [NSLocalizedDescriptionKey: r.err]) }
    return r.out.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  /// Lines in the wrapper's log that are a git call containing `text`.
  func gitCalls(containing text: String) -> Int {
    let log = (try? String(contentsOfFile: home + "/git.log", encoding: .utf8)) ?? ""
    return log.split(separator: "\n").filter { $0.hasPrefix("git ") && $0.contains(text) }.count
  }

  func order() -> [String] {
    ((try? String(contentsOfFile: home + "/order.log", encoding: .utf8)) ?? "").split(separator: "\n").map(String.init)
  }

  /// The primary route: the release's own tarball over (test) file://, checked against the stamped sha256.
  func viaArchive(_ c: inout CloneProvisioner.Config) {
    c.expectedSourceSHA256 = sourceSha
    c.sourceBase = "file://" + home + "/release"
  }

  /// Staging or temp leftovers beside the clone and the record.
  func leftovers() -> [String] {
    let parent = AutoSetup.appFolder(home: home)
    return ((try? FileManager.default.contentsOfDirectory(atPath: parent)) ?? []).filter { $0.hasPrefix(".talos-clone-") || $0.hasPrefix(".checkout.") }
  }

  /// A stand-in for Anthropic's installer script: logs its arguments, shows that the owner's secrets did not reach it, and puts a
  /// `claude` where the real one goes (or fails when asked). Returns its file:// address.
  func claudeScript(fail: Bool = false) throws -> String {
    try Self.write(
      home + "/bundle/claude-install.sh",
      """
      #!/bin/bash
      echo "args=$* secret=${OWNER_SECRET:-}" >> "\(home)/claude-install.log"
      \(fail ? "echo 'simulated installer failure' >&2; exit 1" : "")
      mkdir -p "$HOME/.local/bin" && printf '#!/bin/bash\necho claude\n' > "$HOME/.local/bin/claude" && chmod +x "$HOME/.local/bin/claude"
      """)
    return home + "/bundle/claude-install.sh"
  }

  /// An installer for that script (the app's bundled copy), pinned to its real sha256.
  func installer(_ path: String) -> ClaudeInstaller {
    let data = FileManager.default.contents(atPath: path)!
    let sha = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    return ClaudeInstaller(
      env: ["HOME": home, "PATH": home + "/bin:/usr/bin:/bin", "OWNER_SECRET": "hunter2"], home: home, workDir: AutoSetup.appFolder(home: home), scriptPath: path,
      sha256: sha)
  }

  func cleanUp() { try? FileManager.default.removeItem(atPath: home) }

  private static func write(_ path: String, _ text: String) throws {
    try FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    FileManager.default.createFile(atPath: path, contents: Data(text.utf8), attributes: [.posixPermissions: text.hasPrefix("#!") ? 0o755 : 0o644])
  }
}

extension CloneProvisioner.Config {
  var asProvisioner: CloneProvisioner { CloneProvisioner(self) }
}
