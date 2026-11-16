import CryptoKit
import Foundation
import Testing
import TalosDesktopCore
import TalosTestSupport

@testable import TalosSupervisor

/// The app's own updater, end to end on temp folders: a file:// feed signed with the committed TEST key, a local bare "public repo" with
/// the running commit and the release's commit, a clone of it as the bridge checkout, the REAL apply script (stub pnpm, osascript and
/// open on PATH) and, for the zip checks, the REAL install.sh --check-only. A fake awake clock; nothing reads a real Talos home.
@Suite("Auto update: the updater", .serialized)
struct AutoUpdaterTests {
  static func repo() -> String {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { url.deleteLastPathComponent() }
    return url.path
  }

  /// The committed test keys' private halves (PKCS8 PEM: a 16-byte header and the 32-byte seed).
  static func testKey(_ which: String) throws -> [String: String] {
    let d = try Data(contentsOf: URL(fileURLWithPath: repo() + "/packages/protocol/fixtures/release-manifest/test-key.json"))
    let o = try #require(try JSONSerialization.jsonObject(with: d) as? [String: Any])
    return try #require(o[which] as? [String: String])
  }

  /// The committed TEST P-256 keys (software), as the release signer would use the Enclave one.
  static func privateKey(_ which: String) throws -> P256.Signing.PrivateKey {
    try P256.Signing.PrivateKey(pemRepresentation: try #require(try testKey(which)["private_pkcs8_pem"]))
  }

  static func kid(_ which: String) throws -> String { try #require(try testKey(which)["kid"]) }

  /// The raw, low-S signature over the domain line and `json`.
  static func sign(_ json: Data, with which: String) throws -> String {
    let sig = try privateKey(which).signature(for: Data(ReleaseManifest.domain.utf8) + json)
    return ReleaseManifest.lowS(sig.rawRepresentation).base64EncodedString()
  }

  final class Box<T>: @unchecked Sendable {
    let lock = NSLock()
    var v: T
    init(_ v: T) { self.v = v }
    func get() -> T { lock.withLock { v } }
    func set(_ n: T) { lock.withLock { v = n } }
    func edit(_ f: (inout T) -> Void) { lock.withLock { f(&v) } }
  }

  /// Everything one test needs, in a temp folder of its own.
  final class Rig: @unchecked Sendable {
    let root: String
    let feed: String
    let home: String
    let checkout: String
    let dest: String
    let stub: String
    let stubLog: String
    var a = ""
    var b = ""
    let posts = Box<[String]>([])
    let fetches = Box(0)
    let downloads = Box(0)
    let spawns = Box<[[String]]>([])
    let on = Box(true)
    let busy = Box<[String]>([])
    let clock = Box(1000.0)
    let extraEnv = Box<[String: String]>([:])
    /// The owner's activity as status.json would say it; a change in the notice postpones.
    let owner = Box<String?>("2026-11-14T20:00:00Z")
    /// pid to kernel start time, for the swap's liveness (empty: every pid is gone).
    let starts = Box<[Int32: Double]>([:])
    let stopped = Box<[Int32]>([])
    /// Whether the app is healthy NOW (the check right before a swap).
    let healthyNow = Box(true)
    /// What the new app was asked about after the update (commit, since) and asked to restart Main onto.
    let healthAsked = Box<[(String, Double)]>([])
    let mainRestarts = Box<[String]>([])
    /// The live bridge's commit as status.json would say it (nil: unknown), what a restart of Main answers, and its calls.
    let bridgeCommit = Box<String?>(nil)
    let restartAnswer = Box<AutoUpdate.MainRestart>(.started)
    let restartsOnto = Box<[String]>([])
    let mainCanRestart = Box(true)
    /// Added to the wall clock (a long prepare, a day passing).
    let wallShift = Box(0.0)

    init() throws {
      root = try TestTemp.real(TestTemp.base) + "au-\(UUID().uuidString.prefix(8))"
      feed = root + "/feed"
      home = root + "/talos-home"
      checkout = root + "/co"
      dest = root + "/Applications"
      stub = root + "/stub"
      stubLog = root + "/stub.log"
      for d in [feed, home, dest + "/Talos.app", stub] { try FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true) }
      try write(stub + "/pnpm", "#!/bin/bash\necho \"pnpm $*\" >> \"$STUBLOG\"\nexit ${PNPM_RC:-0}\n", mode: 0o755)
      try write(stub + "/osascript", "#!/bin/bash\necho \"osascript $*\" >> \"$STUBLOG\"\necho false\n", mode: 0o755)
      try write(stub + "/open", "#!/bin/bash\necho \"open $*\" >> \"$STUBLOG\"\n", mode: 0o755)
      try makeRepo()
    }

    deinit { try? FileManager.default.removeItem(atPath: root) }

    func write(_ path: String, _ text: String, mode: Int = 0o644) throws {
      try Data(text.utf8).write(to: URL(fileURLWithPath: path))
      chmod(path, mode_t(mode))
    }

    var env: [String: String] {
      var e = [
        "PATH": stub + ":/usr/bin:/bin:/usr/sbin:/sbin", "HOME": root + "/userhome", "STUBLOG": stubLog,
        "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1", "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com",
        "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com", "TMPDIR": root + "/tmp",
      ]
      for (k, v) in extraEnv.get() { e[k] = v }
      return e
    }

    @discardableResult
    func git(_ args: [String], in dir: String? = nil) -> String {
      let r = ProcessRunner.run(["/usr/bin/git"] + (dir.map { ["-C", $0] } ?? []) + args, env: env, timeout: 30)
      return r.out.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The public repo: A (the checkout's commit; its install.sh stub answers --check-only with CHECK_RC) and B (the release; its stub
    /// "installs" with INSTALL_RC). A real install.sh copy can stand in for A's with `realInstallSh`.
    func makeRepo(realInstallSh: Bool = false) throws {
      let src = root + "/src"
      let origin = root + "/origin.git"
      try FileManager.default.createDirectory(atPath: root + "/tmp", withIntermediateDirectories: true)
      try FileManager.default.createDirectory(atPath: root + "/userhome", withIntermediateDirectories: true)
      git(["init", "-q", "--bare", origin])
      git(["init", "-q", "-b", "main", src])
      try FileManager.default.createDirectory(atPath: src + "/apps/desktop/scripts", withIntermediateDirectories: true)
      let install = src + "/apps/desktop/scripts/install.sh"
      if realInstallSh {
        try FileManager.default.copyItem(atPath: AutoUpdaterTests.repo() + "/apps/desktop/scripts/install.sh", toPath: install)
      } else {
        try write(install, "#!/bin/bash\necho \"install A $*\" >> \"$STUBLOG\"\nexit ${CHECK_RC:-0}\n", mode: 0o755)
      }
      git(["-C", src, "add", "-A"]); git(["-C", src, "commit", "-qm", "A"])
      a = git(["-C", src, "rev-parse", "HEAD"])
      try? FileManager.default.removeItem(atPath: install)
      try write(
        install, "#!/bin/bash\necho \"install B $*\" >> \"$STUBLOG\"\n[ \"$1\" = --rollback ] && exit ${ROLLBACK_RC:-0}\nexit ${INSTALL_RC:-0}\n",
        mode: 0o755)
      git(["-C", src, "add", "-A"]); git(["-C", src, "commit", "-qm", "B"])
      b = git(["-C", src, "rev-parse", "HEAD"])
      git(["-C", src, "push", "-q", origin, "\(a):refs/heads/main", "\(b):refs/tags/v1.5.0"])
      git(["-C", origin, "symbolic-ref", "HEAD", "refs/heads/main"])
      git(["clone", "-q", origin, checkout])
    }

    /// The feed: the zip (`zipBytes`), and latest.json naming `sha` (default: the zip's own), signed by `key`.
    func publish(
      version: String = "1.5.0", zipBytes: Data = Data("zip".utf8), sha: String? = nil, key: String = "test", tamper: Bool = false,
      keys: [String: Any]? = nil
    ) throws {
      let name = "Talos-\(version)-universal.zip"
      try zipBytes.write(to: URL(fileURLWithPath: feed + "/" + name))
      let digest = SHA256.hash(data: zipBytes).map { String(format: "%02x", $0) }.joined()
      var m: [String: Any] = [
        "v": 1, "kid": try AutoUpdaterTests.kid(key), "version": version, "git_sha": b, "tag": "v" + version, "min_app_version": "1.0.0",
        "zip_url": "https://example.com/releases/download/v\(version)/\(name)", "zip_name": name, "zip_sha256": sha ?? digest,
        "size": zipBytes.count, "team_id": "ABCDE12345", "published_at": "2026-11-14T20:00:00Z",
      ]
      if let keys { m["keys"] = keys }
      var json = try JSONSerialization.data(withJSONObject: m, options: [.sortedKeys, .withoutEscapingSlashes])
      let sig = try AutoUpdaterTests.sign(json, with: key)
      if tamper { json = Data(String(decoding: json, as: UTF8.self).replacingOccurrences(of: "ABCDE12345", with: "ZZZZZ12345").utf8) }
      try json.write(to: URL(fileURLWithPath: feed + "/latest.json"))
      try Data((sig + "\n").utf8).write(to: URL(fileURLWithPath: feed + "/latest.json.sig"))
    }

    /// An updater as the app makes one, with these hooks; `spawn` runs the real apply script to its end (as the detached one would).
    /// The swaps started for real (`realSwap`), kept so the test can wait for them.
    let procs = Box<[Process]>([])

    /// `realSwap`: the swap starts as a real process and returns at once (as the detached one does), and processes are looked up
    /// for real; otherwise the swap runs to its end inside the spawn. `healthy`: what this app says of its own health.
    func updater(
      version: String = "1.4.0", wallOffset: Double = 0, look: (@Sendable () -> [String])? = nil, healthy: Bool = false,
      realSwap: Bool = false, appPath: String? = nil
    ) -> AutoUpdater {
      var o = AutoUpdater.Options(
        talosHome: home, appPath: appPath ?? dest + "/Talos.app", appVersion: version, keys: ReleaseTrust.testKeys)
      o.allowLocalFeed = true
      o.firstCheckAfter = 0
      o.applyScript = AutoUpdaterTests.repo() + "/apps/desktop/scripts/auto-update-apply.sh"
      o.auditLogPath = root + "/audit.log"
      o.healthWait = 2
      let feedURL = URL(fileURLWithPath: feed, isDirectory: true).absoluteString
      var h = AutoUpdater.Hooks(
        settings: { [on] in (on.get(), feedURL) }, checkout: { [checkout] in checkout },
        look: look ?? { [busy] in busy.get() }, post: { [posts] text in posts.edit { $0.append(text) } },
        env: { [unowned self] in self.env })
      let fetch = h.fetch
      h.fetch = { [fetches] url, max, t in
        fetches.edit { $0 += 1 }
        return fetch(url, max, t)
      }
      let download = h.download
      h.download = { [downloads] url, path, max, t in
        downloads.edit { $0 += 1 }
        return download(url, path, max, t)
      }
      h.spawn = { [spawns, root] argv, env, log in
        spawns.edit { $0.append(argv) }
        let r = ProcessRunner.run(argv, env: env, timeout: 120)
        try? (r.out + r.err).write(toFile: root + "/apply-out.log", atomically: true, encoding: .utf8)
        return 999_999  // a pid that is gone by the time anyone looks
      }
      h.awake = { [clock] in clock.get() }
      h.wall = { [wallShift] in Date().timeIntervalSince1970 + wallOffset + wallShift.get() }
      h.processStart = { [starts] pid in starts.get()[pid] }
      h.stopGroup = { [stopped] pid in stopped.edit { $0.append(pid) } }
      h.ownerActivity = { [owner] in owner.get() }
      h.healthy = { [healthyNow] in healthyNow.get() }
      h.healthyAfterUpdate = { [healthAsked] commit, since in
        healthAsked.edit { $0.append((commit, since)) }
        return healthy
      }
      h.restartMainForUpdate = { [mainRestarts] commit in mainRestarts.edit { $0.append(commit) } }
      h.bridgeNotOn = { [bridgeCommit] head in
        guard let c = bridgeCommit.get() else { return true }
        return !head.hasPrefix(c)
      }
      h.restartMainOnto = { [restartAnswer, restartsOnto] head in
        restartsOnto.edit { $0.append(head) }
        return restartAnswer.get()
      }
      h.mainCanRestart = { [mainCanRestart] in mainCanRestart.get() }
      if realSwap {
        h.spawn = { [spawns, procs, root] argv, env, _ in
          spawns.edit { $0.append(argv) }
          let p = Process()
          p.executableURL = URL(fileURLWithPath: argv[0])
          p.arguments = Array(argv.dropFirst())
          p.environment = env
          p.standardInput = FileHandle.nullDevice
          FileManager.default.createFile(atPath: root + "/apply-out.log", contents: nil)
          p.standardOutput = FileHandle(forWritingAtPath: root + "/apply-out.log")
          p.standardError = p.standardOutput
          guard (try? p.run()) != nil else { return nil }
          procs.edit { $0.append(p) }
          return p.processIdentifier
        }
        h.processStart = { ProcessInspect.basic($0)?.startTime }
      }
      return AutoUpdater(options: o, hooks: h)
    }

    /// Ticks 30 s apart until the swap is started (or `max` ticks): the check, two quiet looks, the notice, its 2 minutes, the prepare
    /// and two more quiet looks.
    func driveToSwap(_ u: AutoUpdater, max: Int = 20) {
      for _ in 0..<max {
        if !spawns.get().isEmpty { return }
        u.tick()
        clock.edit { $0 += 30 }
      }
    }

    /// The swap started for real still running.
    var swapRunning: Bool { procs.get().contains { $0.isRunning } }

    /// The new version's app while the swap waits for its report: ticks until the swap has ended (at most 30 s), then once more.
    func runNewApp(healthy: Bool) -> AutoUpdater {
      let app = updater(version: "1.5.0", healthy: healthy, realSwap: true)
      _ = waitUntil(timeout: 30, poll: 0.2) {
        app.tick()
        return !swapRunning
      }
      app.tick()
      return app
    }

    func head() -> String { git(["rev-parse", "HEAD"], in: checkout) }
    func branch() -> String { git(["symbolic-ref", "--quiet", "--short", "HEAD"], in: checkout) }
    func audit() -> String { (try? String(contentsOfFile: root + "/audit.log", encoding: .utf8)) ?? "" }
    func log() -> String { (try? String(contentsOfFile: stubLog, encoding: .utf8)) ?? "" }
  }

  // MARK: refused before anything is downloaded

  @Test func switchedOffFetchesNothing() throws {
    let r = try Rig()
    try r.publish()
    r.on.set(false)
    let u = r.updater()
    for _ in 0..<3 { u.tick() }
    #expect(r.fetches.get() == 0 && r.downloads.get() == 0 && r.posts.get().isEmpty)
    #expect(r.audit().contains("auto_update off"))
  }

  @Test func aTamperedManifestIsRefusedAndSaidOnce() throws {
    let r = try Rig()
    try r.publish(tamper: true)
    let u = r.updater()
    u.tick()
    #expect(r.downloads.get() == 0)
    #expect(r.posts.get() == ["Talos couldn't update to a new version: the release's signature did not check out. It's still on 1.4.0."])
    r.clock.edit { $0 += AutoUpdate.checkEvery + 1 }
    u.tick()
    #expect(r.fetches.get() == 4, "the next check looked again")
    #expect(r.posts.get().count == 1, "the same refusal is said once")
  }

  /// The app runs from a translocated copy (it still carried the download flag): nothing is fetched or swapped, and the owner gets
  /// the one line, once, however many checks follow. Moved and reopened (a normal path), the same release goes ahead.
  @Test func aTranslocatedAppRefusesToUpdateAndSaysSoOnce() throws {
    let r = try Rig()
    try r.publish()
    let moved = r.root + "/var/folders/xy/abc123/T/AppTranslocation/6F1C2A9E-0B3D-4E5F-8A7B-9C0D1E2F3A4B/d/Talos.app"
    let u = r.updater(appPath: moved)
    u.tick()
    r.clock.edit { $0 += AutoUpdate.checkEvery + 1 }
    u.tick()
    #expect(r.fetches.get() == 0 && r.downloads.get() == 0 && r.spawns.get().isEmpty)
    #expect(r.posts.get() == [AutoUpdate.translocatedLine], "said once, in the default thread")
    #expect(r.audit().contains("auto_update translocated"))
    let fresh = r.updater()
    fresh.tick()
    #expect(r.fetches.get() == 2 && r.downloads.get() == 1, "the app in its own folder checks and downloads as usual")
  }

  @Test func aManifestSignedByAnotherKeyIsRefused() throws {
    let r = try Rig()
    try r.publish(key: "other")
    r.updater().tick()
    #expect(r.downloads.get() == 0 && r.spawns.get().isEmpty)
    #expect(r.posts.get().first?.contains("signature did not check out") == true)
    #expect(r.audit().contains("refused why=unknown_kid"))
  }

  // MARK: key rotation

  func nextKeyUpdate(retire: [String]) throws -> [String: Any] {
    let n = try AutoUpdaterTests.testKey("next")
    return ["add": [["kid": n["kid"]!, "pub": n["public_key"]!]], "retire": retire]
  }

  @Test func aSignedRotationIsKeptAndTheRetiredKeyIsRefusedFromThenOn() throws {
    let r = try Rig()
    let test = try AutoUpdaterTests.kid("test")
    let next = try AutoUpdaterTests.kid("next")
    try r.publish(version: "1.4.0", keys: try nextKeyUpdate(retire: [test]))  // signed by the test key, trusted now
    let u = r.updater()
    u.tick()
    let path = r.home + "/auto-update/keys.json"
    let stored = try JSONDecoder().decode(ReleaseKeyring.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
    #expect(stored.keys.map(\.kid) == [next] && stored.retired == [test])
    #expect((try FileManager.default.attributesOfItem(atPath: path)[.posixPermissions] as? NSNumber)?.intValue == 0o600)
    #expect(u.keyring().keys.map(\.kid) == [next], "the pinned test key is retired")
    // a release signed by the retired key is refused from then on
    try r.publish()
    r.clock.edit { $0 += AutoUpdate.checkEvery + 1 }
    u.tick()
    #expect(r.audit().contains("refused why=retired_kid") && r.downloads.get() == 0)
    // one signed by the new key goes through
    try r.publish(key: "next")
    r.clock.edit { $0 += AutoUpdate.checkEvery + 1 }
    let again = r.updater()
    again.tick()
    #expect(r.downloads.get() == 1)
  }

  @Test func aRotationThatWouldLeaveNoKeyIsRefusedAndNothingIsStored() throws {
    let r = try Rig()
    let test = try AutoUpdaterTests.kid("test")
    try r.publish(version: "1.4.0", keys: ["add": [Any](), "retire": [test]])
    r.updater().tick()
    #expect(!FileManager.default.fileExists(atPath: r.home + "/auto-update/keys.json"))
    #expect(r.audit().contains("keys_update_refused version=1.4.0 why=would_empty"))
  }

  @Test func aRotationInAManifestThatDoesNotVerifyChangesNothing() throws {
    let r = try Rig()
    let test = try AutoUpdaterTests.kid("test")
    try r.publish(version: "1.4.0", key: "other", keys: try nextKeyUpdate(retire: [test]))  // other: not trusted
    r.updater().tick()
    #expect(!FileManager.default.fileExists(atPath: r.home + "/auto-update/keys.json"))
  }

  @Test func aStoredKeyringIsNeverWrittenEmpty() throws {
    let r = try Rig()
    let next = try AutoUpdaterTests.kid("next")
    try r.publish(version: "1.4.0", keys: try nextKeyUpdate(retire: []))
    r.updater().tick()
    // a later update retiring both is refused whole: the stored list keeps its keys
    let test = try AutoUpdaterTests.kid("test")
    try r.publish(version: "1.4.0", keys: ["add": [Any](), "retire": [test, next]])
    r.clock.edit { $0 += AutoUpdate.checkEvery + 1 }
    r.updater().tick()
    let stored = try JSONDecoder().decode(
      ReleaseKeyring.self, from: Data(contentsOf: URL(fileURLWithPath: r.home + "/auto-update/keys.json")))
    #expect(!stored.keys.isEmpty && stored.retired.isEmpty)
  }

  @Test func anOlderReleaseIsNeverInstalled() throws {
    let r = try Rig()
    try r.publish(version: "1.3.0")
    let u = r.updater(version: "1.4.0")
    u.tick()
    #expect(r.downloads.get() == 0 && r.posts.get().isEmpty)
    #expect(r.audit().contains("decision=downgrade"))
    try r.publish(version: "1.4.0")
    r.clock.edit { $0 += AutoUpdate.checkEvery }
    u.tick()
    #expect(r.downloads.get() == 0 && r.audit().contains("decision=up_to_date"))
  }

  @Test func aDirtyCheckoutIsRefusedBeforeTheDownload() throws {
    let r = try Rig()
    try r.publish()
    try r.write(r.checkout + "/notes.txt", "mine")
    r.updater().tick()
    #expect(r.downloads.get() == 0)
    #expect(r.posts.get() == ["Talos couldn't update to 1.5.0: the Talos code folder has changes of its own. It's still on 1.4.0."])
  }

  // MARK: refused after the download

  @Test func aZipThatIsNotTheNamedOneIsRefused() throws {
    let r = try Rig()
    try r.publish(sha: String(repeating: "b", count: 64))
    r.updater().tick()
    #expect(r.downloads.get() == 1)
    #expect(r.posts.get().first?.contains("the download is not the file the release names") == true)
    #expect(!FileManager.default.fileExists(atPath: r.home + "/auto-update/1.5.0"), "the download is gone")
    #expect(!r.log().contains("install A"), "install.sh is never asked about a file that is not the release's")
  }

  @Test func anAdHocAppIsRefusedByTheRealInstallSh() throws {
    let r = try Rig()
    try FileManager.default.removeItem(atPath: r.checkout)
    try FileManager.default.removeItem(atPath: r.root + "/origin.git")
    try FileManager.default.removeItem(atPath: r.root + "/src")
    try r.makeRepo(realInstallSh: true)
    // a Talos-shaped bundle around an ad hoc signed copy of /usr/bin/true, zipped as release-app.sh zips
    let app = r.root + "/build/Talos.app"
    try FileManager.default.createDirectory(atPath: app + "/Contents/MacOS", withIntermediateDirectories: true)
    try FileManager.default.copyItem(atPath: "/usr/bin/true", toPath: app + "/Contents/MacOS/Talos")
    try r.write(
      app + "/Contents/Info.plist",
      #"<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>app.talos.desktop</string><key>CFBundleExecutable</key><string>Talos</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>"#)
    #expect(ProcessRunner.run(["/usr/bin/codesign", "-s", "-", "--force", app], timeout: 60).ok)
    let zip = r.root + "/build/t.zip"
    #expect(ProcessRunner.run(["/usr/bin/ditto", "-c", "-k", "--keepParent", app, zip], timeout: 60).ok)
    try r.publish(zipBytes: Data(contentsOf: URL(fileURLWithPath: zip)))
    r.updater().tick()
    #expect(r.posts.get() == ["Talos couldn't update to 1.5.0: the app in the release is not signed and notarized by its publisher. It's still on 1.4.0."])
    #expect(r.spawns.get().isEmpty && r.audit().contains("app_check_failed exit=9"))
  }

  // MARK: waiting for quiet

  @Test func notQuietWaitsAndQuietTwiceGoes() throws {
    let r = try Rig()
    try r.publish()
    r.busy.set(["thread t_one busy"])
    let u = r.updater()
    u.tick()  // the check: ready
    #expect(r.audit().contains("auto_update ready version=1.5.0"), "\(r.audit())")
    for _ in 0..<5 {
      r.clock.edit { $0 += 30 }
      u.tick()
    }
    #expect(r.spawns.get().isEmpty, "nothing moves while a session is busy")
    #expect(r.audit().contains("waiting version=1.5.0 why=thread t_one busy"))
    r.busy.set([])
    r.clock.edit { $0 += 30 }
    u.tick()
    #expect(r.spawns.get().isEmpty, "one quiet look is not enough")
    r.clock.edit { $0 += 30 }
    u.tick()
    #expect(r.posts.get() == ["Talos will update to 1.5.0 in 2 minutes; send anything to postpone."], "two quiet looks: the notice")
    #expect(r.spawns.get().isEmpty && r.head() == r.a, "nothing moves during the notice")
    for _ in 0..<3 {
      r.clock.edit { $0 += 30 }
      u.tick()
    }
    #expect(r.spawns.get().isEmpty, "the 2 minutes are not over")
    r.clock.edit { $0 += 30 }
    u.tick()  // 2 minutes: the prepare
    #expect(r.head() == r.b && r.audit().contains("auto_update prepared commit="), "\(r.audit())")
    #expect(r.spawns.get().isEmpty, "the last look first: two quiet looks after the prepare")
    r.clock.edit { $0 += 30 }
    u.tick()
    #expect(r.spawns.get().isEmpty, "one quiet look after the prepare is not enough")
    // a long prepare: the swap's 30 minutes must count from the swap itself
    r.wallShift.set(AutoUpdate.applyCap)
    r.clock.edit { $0 += 30 }
    u.tick()
    #expect(r.spawns.get().count == 1, "the second one starts the swap")
    // the record's start is the swap's own (after the long prepare), so a swap still at work is not over its time at once
    let pending = try JSONDecoder().decode(
      AutoUpdate.Pending.self, from: Data(contentsOf: URL(fileURLWithPath: r.home + "/auto-update/pending.json")))
    let started = try #require(ISOTime.parse(pending.started_at))
    #expect(started >= Date().timeIntervalSince1970 + AutoUpdate.applyCap - 60, "counted from the swap, not the prepare")
    r.starts.set([999_999: 5.0])
    var alive = pending
    alive.helper_started = 5.0
    #expect(AutoUpdate.helperAlive(alive, now: Date().timeIntervalSince1970 + AutoUpdate.applyCap) { r.starts.get()[$0] })
  }

  @Test func anOwnerMessageInTheNoticePostponesAndNothingMoves() throws {
    let r = try Rig()
    try r.publish()
    let u = r.updater()
    for _ in 0..<3 {
      u.tick()
      r.clock.edit { $0 += 30 }
    }
    #expect(r.posts.get().last?.hasPrefix("Talos will update to 1.5.0 in 2 minutes") == true)
    r.owner.set("2026-11-14T20:05:00Z")  // the owner writes
    u.tick()
    #expect(r.posts.get().last == "Talos postponed the update to 1.5.0; it tries again when nothing is going on.")
    #expect(r.audit().contains("postponed version=1.5.0 why=the owner wrote"))
    #expect(r.head() == r.a && !r.log().contains("pnpm"), "the checkout never moved")
    for _ in 0..<10 {
      r.clock.edit { $0 += 60 }
      u.tick()
    }
    #expect(r.spawns.get().isEmpty && r.posts.get().count == 2, "nothing before the postponement is over")
    r.clock.edit { $0 += AutoUpdate.postponeFor }
    r.driveToSwap(u)
    #expect(r.spawns.get().count == 1, "it goes in the next quiet window")
  }

  @Test func busyAtTheLastLookPutsTheCheckoutBack() throws {
    let r = try Rig()
    try r.publish()
    let u = r.updater()
    for _ in 0..<8 {
      if r.head() == r.b { break }
      u.tick()
      r.clock.edit { $0 += 30 }
    }
    #expect(r.head() == r.b, "prepared")
    #expect(FileManager.default.fileExists(atPath: r.home + "/auto-update/pending.json"))
    r.busy.set(["thread t_one busy"])
    u.tick()
    #expect(r.head() == r.a && r.branch() == "main", "the checkout is back where it was")
    #expect(r.spawns.get().isEmpty && r.audit().contains("postponed version=1.5.0 why=thread t_one busy"))
    #expect(!FileManager.default.fileExists(atPath: r.home + "/auto-update/pending.json"), "nothing is left pending")
    u.tick()
    #expect(!r.posts.get().contains { $0.hasPrefix("Talos couldn't") }, "a postponement is no failure")
  }

  @Test func aFailedReleaseIsNotTriedAgainForADay() throws {
    let r = try Rig()
    try r.publish(sha: String(repeating: "b", count: 64))
    let u = r.updater()
    u.tick()
    #expect(r.downloads.get() == 1 && r.posts.get().count == 1)
    r.clock.edit { $0 += AutoUpdate.checkEvery }
    u.tick()
    #expect(r.downloads.get() == 1 && r.audit().contains("recently_failed version=1.5.0"), "not again within a day")
    // a day later (the record is on the wall clock): tried again, and the same failure is not said twice
    let wallShift = AutoUpdate.retryFailedAfter + 1
    let shifted = r.updater(wallOffset: wallShift)
    shifted.tick()
    #expect(r.downloads.get() == 2)
    #expect(r.posts.get().count == 1, "the line once per version and reason")
  }

  @Test func neverQuietGivesUpAtTwoHoursAndTriesAtTheNextCheck() throws {
    let r = try Rig()
    try r.publish()
    r.busy.set(["main busy"])
    let u = r.updater()
    u.tick()
    r.clock.edit { $0 += AutoUpdate.quietCap }
    u.tick()
    #expect(r.audit().contains("gave_up_waiting version=1.5.0"))
    r.busy.set([])
    r.clock.edit { $0 += 60 }
    u.tick()
    #expect(r.spawns.get().isEmpty && r.downloads.get() == 1, "not before the next check")
    r.clock.edit { $0 += AutoUpdate.checkEvery }
    u.tick()
    #expect(r.downloads.get() == 2)
  }

  @Test func switchedOffWhileWaitingDropsTheRelease() throws {
    let r = try Rig()
    try r.publish()
    r.busy.set(["main busy"])
    let u = r.updater()
    u.tick()
    #expect(FileManager.default.fileExists(atPath: r.home + "/auto-update/1.5.0"))
    r.on.set(false)
    u.tick()
    r.busy.set([])
    for _ in 0..<3 { r.clock.edit { $0 += 30 }; u.tick() }
    #expect(r.spawns.get().isEmpty && !FileManager.default.fileExists(atPath: r.home + "/auto-update/1.5.0"))
  }

  /// Background work: a real process tree under a "pane" (a shell running a sleep) keeps the updater waiting; once it ends, it goes.
  @Test func backgroundWorkUnderAPaneWaits() throws {
    let r = try Rig()
    try r.publish()
    let pane = Process()
    pane.executableURL = URL(fileURLWithPath: "/bin/sh")
    pane.arguments = ["-c", "/bin/sleep 60; true"]
    try pane.run()
    defer { if pane.isRunning { pane.terminate() } }
    #expect(waitUntil(timeout: 10) { (ProcTable.live() ?? []).contains { $0.ppid == pane.processIdentifier && $0.name == "sleep" } })
    let pid = pane.processIdentifier
    let alive = Box(true)
    let u = r.updater(look: { alive.get() ? [ProcTable.reason(panes: [pid])].compactMap { $0 } : [] })
    u.tick()
    for _ in 0..<3 {
      r.clock.edit { $0 += 30 }
      u.tick()
    }
    #expect(r.spawns.get().isEmpty)
    #expect(r.audit().contains("why=background work: sleep (pid "))
    pane.terminate()
    pane.waitUntilExit()
    alive.set(false)
    for _ in 0..<2 {
      r.clock.edit { $0 += 30 }
      u.tick()
    }
    #expect(r.posts.get().first?.hasPrefix("Talos will update to 1.5.0 in 2 minutes") == true, "quiet: the notice goes out")
  }

  /// A process named claude with an MCP-like child (a sleep) is not work; a Bash-tool-like child (a shell) is.
  @Test func claudesOwnChildrenAreNotWorkItsShellsAre() throws {
    let r = try Rig()
    let claude = r.root + "/bin/claude"
    try FileManager.default.createDirectory(atPath: r.root + "/bin", withIntermediateDirectories: true)
    // a copy (re-signed ad hoc: a moved platform binary is refused), so the kernel names the process "claude"
    try FileManager.default.copyItem(atPath: "/bin/bash", toPath: claude)
    #expect(ProcessRunner.run(["/usr/bin/codesign", "-s", "-", "--force", claude], timeout: 60).ok)
    let p = Process()
    p.executableURL = URL(fileURLWithPath: claude)
    p.arguments = ["-c", "/bin/sleep 60 & wait"]
    try p.run()
    defer { if p.isRunning { p.terminate() } }
    #expect(waitUntil(timeout: 10) { (ProcTable.live() ?? []).contains { $0.ppid == p.processIdentifier && $0.name == "sleep" } })
    #expect(ProcTable.reason(panes: [p.processIdentifier]) == nil, "a server claude started is its own")
    let q = Process()
    q.executableURL = URL(fileURLWithPath: claude)
    q.arguments = ["-c", "/bin/zsh -c '/bin/sleep 60; true' & wait"]
    try q.run()
    defer { if q.isRunning { q.terminate() } }
    #expect(waitUntil(timeout: 10) { (ProcTable.live() ?? []).contains { $0.ppid == q.processIdentifier && $0.name == "zsh" } })
    #expect(ProcTable.reason(panes: [q.processIdentifier])?.contains("background work: zsh (pid ") == true)
    for x in [p, q] { _ = ProcessRunner.run(["/usr/bin/pkill", "-P", "\(x.processIdentifier)"], timeout: 5) }
  }

  // MARK: the swap and the line

  @Test func anUpdateMovesTheCheckoutSwapsAndSaysSoAfterTheRelaunch() throws {
    let r = try Rig()
    try r.publish()
    let u = r.updater(realSwap: true)
    r.driveToSwap(u)
    let argv = try #require(r.spawns.get().first)
    #expect(argv.contains(r.b) && argv.contains("--team") && argv[1] == r.home + "/auto-update/auto-update-apply.sh", "a copy of the script runs")
    #expect(argv.contains(r.home + "/auto-update/healthy-1.5.0.json"), "the swap waits for the new version's own report")
    #expect(r.posts.get() == [AutoUpdate.noticeLine("1.5.0")], "only the notice until the new app is up")
    // the relaunch: the new version comes up healthy, reports it, and settles once the swap has seen the report
    let next = r.runNewApp(healthy: true)
    #expect(r.head() == r.b, "the checkout is on the release's commit")
    #expect(r.log().contains("install B --from-release \(r.home)/auto-update/1.5.0/Talos-1.5.0-universal.zip"))
    #expect(r.log().contains("--no-relay-wait"), "the relay updates on its own: never waited for")
    #expect(!r.log().contains("--rollback"))
    #expect(r.audit().contains("auto_update healthy version=1.5.0"))
    next.tick()
    #expect(r.posts.get().last == "Talos updated to 1.5.0. The relay updates separately.")
    #expect(r.posts.get().count == 2)
    #expect(!FileManager.default.fileExists(atPath: r.home + "/auto-update/pending.json"))
    #expect(!FileManager.default.fileExists(atPath: r.home + "/auto-update/healthy-1.5.0.json"))
    #expect(r.audit().contains("auto_update updated from=1.4.0 version=1.5.0"))
  }

  // MARK: the health gate

  @Test func aNewAppThatNeverLaunchesIsRolledBack() throws {
    let r = try Rig()
    try r.publish()
    let u = r.updater(realSwap: true)
    r.driveToSwap(u)
    #expect(waitUntil(timeout: 30) { !r.swapRunning })
    #expect(r.log().contains("install B --rollback --dest \(r.dest) --no-open"), "\(r.log())")
    #expect(r.head() == r.a && r.branch() == "main", "the code folder is back on the previous commit")
    #expect(r.log().contains("open \(r.dest)/Talos.app"), "the previous app is opened")
    // the previous app settles it
    let old = r.updater(version: "1.4.0")
    old.tick()
    #expect(r.posts.get().last == "Talos 1.5.0 didn't start properly, so it went back to 1.4.0. The update is paused for a week.")
  }

  @Test func aNewAppThatNeverGetsReadyIsRolledBackAndNeverWritesTheReport() throws {
    let r = try Rig()
    try r.publish()
    let u = r.updater(realSwap: true)
    r.driveToSwap(u)
    _ = r.runNewApp(healthy: false)
    #expect(!r.audit().contains("auto_update healthy"))
    #expect(r.log().contains("--rollback") && r.head() == r.a)
    let old = r.updater(version: "1.4.0")
    old.tick()
    #expect(r.posts.get().last == AutoUpdate.unhealthyLine("1.5.0", old: "1.4.0"))
  }

  @Test func theOldAppNeverReportsTheNewVersionHealthy() throws {
    let r = try Rig()
    try r.publish()
    let u = r.updater(realSwap: true)
    r.driveToSwap(u)
    // the previous app, healthy itself, ticking while the swap waits: its report would be for 1.4.0, never for 1.5.0
    let old = r.updater(version: "1.4.0", healthy: true, realSwap: true)
    _ = waitUntil(timeout: 30, poll: 0.2) {
      old.tick()
      return !r.swapRunning
    }
    #expect(!FileManager.default.fileExists(atPath: r.home + "/auto-update/healthy-1.5.0.json"))
    #expect(r.log().contains("--rollback"))
  }

  @Test func aRollbackThatFailsSaysSoAndLeavesTheKeptCopy() throws {
    let r = try Rig()
    try r.publish()
    try FileManager.default.createDirectory(atPath: r.dest + "/.Talos.app.previous", withIntermediateDirectories: true)
    r.extraEnv.set(["ROLLBACK_RC": "3"])
    let u = r.updater(realSwap: true)
    r.driveToSwap(u)
    #expect(waitUntil(timeout: 30) { !r.swapRunning })
    #expect(FileManager.default.fileExists(atPath: r.dest + "/.Talos.app.previous"), "the kept copy is where it was")
    #expect(r.head() == r.b, "the code folder stays with the app that is still installed")
    // the new version is what is installed: it settles it, and never calls itself updated
    let now = r.updater(version: "1.5.0")
    now.tick()
    #expect(r.posts.get().last == AutoUpdate.rollbackFailedLine("1.5.0", old: "1.4.0"))
    #expect(!r.posts.get().contains { $0.hasPrefix("Talos updated") })
  }

  @Test func aRolledBackVersionIsNotTriedAgainButANewerOneIs() throws {
    let r = try Rig()
    try r.publish()
    let u = r.updater(realSwap: true)
    r.driveToSwap(u)
    #expect(waitUntil(timeout: 30) { !r.swapRunning })
    let old = r.updater(version: "1.4.0")
    old.tick()  // settles: 1.5.0 skipped
    let downloads = r.downloads.get()
    r.clock.edit { $0 += AutoUpdate.checkEvery + 1 }
    let later = r.updater(version: "1.4.0", wallOffset: 3 * 24 * 3600)  // past the 24 h memory, inside the week
    later.tick()
    #expect(r.downloads.get() == downloads && r.audit().contains("skipped_version version=1.5.0"), "1.5.0 is skipped for the week")
    // a week on: tried once more
    let weekOn = r.updater(version: "1.4.0", wallOffset: AutoUpdate.skipFor + 3600)
    weekOn.tick()
    #expect(r.downloads.get() == downloads + 1, "after a week the same version is tried once more")
    try r.publish(version: "1.6.0")
    r.clock.edit { $0 += AutoUpdate.checkEvery + 1 }
    later.tick()
    #expect(r.downloads.get() == downloads + 2, "a newer version is tried at once")
  }

  /// The new app restarted Main onto the release (tmux); the health gate rolled the app back: Main goes back onto the old code too.
  @Test func aRollbackRestartsMainBackOntoThePreviousCode() throws {
    let r = try Rig()
    try r.publish()
    let u = r.updater(realSwap: true)
    r.driveToSwap(u)
    #expect(waitUntil(timeout: 30) { !r.swapRunning })
    r.bridgeCommit.set(String(r.b.prefix(7)))  // Main still on the release's bridge
    let old = r.updater(version: "1.4.0")
    old.tick()
    #expect(r.restartsOnto.get() == [r.a], "Main cold-restarted onto the checkout's HEAD, the previous commit")
    #expect(r.posts.get().last == AutoUpdate.unhealthyLine("1.5.0", old: "1.4.0"))
  }

  @Test func aRollbackWhoseMainCannotRestartSaysHowToFinish() throws {
    let r = try Rig()
    try r.publish()
    let u = r.updater(realSwap: true)
    r.driveToSwap(u)
    #expect(waitUntil(timeout: 30) { !r.swapRunning })
    r.bridgeCommit.set(String(r.b.prefix(7)))
    r.restartAnswer.set(.notYet)
    let old = r.updater(version: "1.4.0")
    old.tick()
    #expect(r.posts.get().last == AutoUpdate.noticeLine("1.5.0"), "Main starting: settled at a later look")
    r.restartAnswer.set(.refused)
    r.clock.edit { $0 += 30 }
    old.tick()
    #expect(
      r.posts.get().last
        == "Talos 1.5.0 didn't start properly, so it went back to 1.4.0. The update is paused for a week. Restart Talos from the menu to finish going back.")
  }

  @Test func aRollbackWithMainAlreadyOnThePreviousCodeRestartsNothing() throws {
    let r = try Rig()
    try r.publish()
    let u = r.updater(realSwap: true)
    r.driveToSwap(u)
    #expect(waitUntil(timeout: 30) { !r.swapRunning })
    r.bridgeCommit.set(String(r.a.prefix(7)))
    r.updater(version: "1.4.0").tick()
    #expect(r.restartsOnto.get().isEmpty)
    #expect(r.posts.get().last == AutoUpdate.unhealthyLine("1.5.0", old: "1.4.0"))
  }

  @Test func aMacWhoseMainWouldNotComeBackPostponesWithoutALine() throws {
    let r = try Rig()
    try r.publish()
    r.mainCanRestart.set(false)
    let u = r.updater()
    for _ in 0..<12 {
      u.tick()
      r.clock.edit { $0 += 30 }
    }
    #expect(r.spawns.get().isEmpty && r.head() == r.a)
    #expect(r.audit().contains("postponed version=1.5.0 why=Main would not come back from a restart"))
    #expect(r.posts.get() == [AutoUpdate.noticeLine("1.5.0")])
  }

  @Test func anOldAppThatIsNotHealthyItselfPostponesWithoutALine() throws {
    let r = try Rig()
    try r.publish()
    r.healthyNow.set(false)  // Main stopped, or the relay down: this app could not judge the new one
    let u = r.updater()
    for _ in 0..<12 {
      u.tick()
      r.clock.edit { $0 += 30 }
    }
    #expect(r.spawns.get().isEmpty, "never swapped")
    #expect(r.head() == r.a && r.branch() == "main", "the checkout is back")
    #expect(r.audit().contains("postponed version=1.5.0 why=this app is not healthy itself"))
    #expect(r.posts.get() == [AutoUpdate.noticeLine("1.5.0")], "nothing said but the notice")
    r.healthyNow.set(true)
    r.clock.edit { $0 += AutoUpdate.postponeFor }
    r.driveToSwap(u)
    #expect(r.spawns.get().count == 1, "the next window goes")
  }

  @Test func theNewAppJudgesItselfOnTheReleasesCommitAndRestartsMainOntoIt() throws {
    let r = try Rig()
    try r.publish()
    let u = r.updater(realSwap: true)
    r.driveToSwap(u)
    let pending = try JSONDecoder().decode(
      AutoUpdate.Pending.self, from: Data(contentsOf: URL(fileURLWithPath: r.home + "/auto-update/pending.json")))
    _ = r.runNewApp(healthy: true)
    let asked = try #require(r.healthAsked.get().first)
    #expect(asked.0 == r.b, "the release's public commit")
    #expect(asked.1 == ISOTime.parse(pending.started_at), "the swap's own start")
    #expect(r.mainRestarts.get().first == r.b, "Main is asked to restart onto the release")
    #expect(r.healthAsked.get().count >= 1 && pending.commit == r.b)
  }

  @Test func aNewAppThatReportedHealthyNeverHasItsSwapStopped() throws {
    let r = try Rig()
    try FileManager.default.createDirectory(atPath: r.home + "/auto-update", withIntermediateDirectories: true)
    r.starts.set([4242: 77.5])
    var p = AutoUpdate.Pending(
      version: "1.5.0", old_version: "1.4.0", checkout: r.checkout, old_ref: "main", old_head: r.a, helper_pid: 4242,
      started_at: ISOTime.string(Date().timeIntervalSince1970 - AutoUpdate.applyCap - 1), helper_started: 77.5)
    p.commit = r.b
    try JSONEncoder().encode(p).write(to: URL(fileURLWithPath: r.home + "/auto-update/pending.json"))
    try Data("{}".utf8).write(to: URL(fileURLWithPath: r.home + "/auto-update/healthy-1.5.0.json"))
    let u = r.updater(version: "1.5.0")
    u.tick()
    #expect(r.stopped.get().isEmpty, "the swap that is about to say ok is never stopped")
  }

  @Test func aFailureAfterTheCheckoutMovedPutsItBackAndSaysWhy() throws {
    let r = try Rig()
    try r.publish()
    r.extraEnv.set(["INSTALL_RC": "9"])
    let u = r.updater()
    r.driveToSwap(u)
    #expect(r.spawns.get().count == 1)
    #expect(r.head() == r.a && r.branch() == "main", "the checkout is back where it was")
    #expect(r.log().contains("open \(r.dest)/Talos.app"), "the kept app is opened again")
    // the old app (still 1.4.0) settles it
    let again = r.updater(version: "1.4.0")
    again.tick()
    #expect(
      r.posts.get().last == "Talos couldn't update to 1.5.0: the app in the release is not signed and notarized by its publisher. It's still on 1.4.0.")
  }

  /// A swap that never says how it ended: at `applyCap` its process group is asked to stop; two minutes on, the checkout goes back
  /// and the line is posted. The swap is known by its pid AND its start time.
  @Test func aSwapOverItsTimeIsStoppedAndTheCheckoutPutBack() throws {
    let r = try Rig()
    r.git(["fetch", "-q", "--tags", "origin"], in: r.checkout)
    r.git(["checkout", "-q", "--detach", r.b], in: r.checkout)
    try FileManager.default.createDirectory(atPath: r.home + "/auto-update", withIntermediateDirectories: true)
    r.starts.set([4242: 77.5])
    let p = AutoUpdate.Pending(
      version: "1.5.0", old_version: "1.4.0", checkout: r.checkout, old_ref: "main", old_head: r.a, helper_pid: 4242,
      started_at: ISOTime.string(Date().timeIntervalSince1970 - AutoUpdate.applyCap - 1), helper_started: 77.5)
    try JSONEncoder().encode(p).write(to: URL(fileURLWithPath: r.home + "/auto-update/pending.json"))
    let u = r.updater(version: "1.4.0")
    u.tick()
    #expect(r.stopped.get() == [4242], "its group is asked to stop")
    #expect(r.posts.get().isEmpty && r.head() == r.b, "it gets two minutes to put things back itself")
    r.clock.edit { $0 += 121 }
    u.tick()
    #expect(r.branch() == "main" && r.head() == r.a)
    #expect(r.posts.get() == ["Talos couldn't update to 1.5.0: the update stopped before it finished. It's still on 1.4.0."])
  }

  @Test func aPidUsedAgainIsNotTheSwap() throws {
    let r = try Rig()
    try FileManager.default.createDirectory(atPath: r.home + "/auto-update", withIntermediateDirectories: true)
    r.starts.set([4242: 99.0])  // alive, but started at another time: another process
    let p = AutoUpdate.Pending(
      version: "1.5.0", old_version: "1.4.0", checkout: r.checkout, old_ref: "main", old_head: r.a, helper_pid: 4242,
      started_at: ISOTime.string(Date().timeIntervalSince1970), helper_started: 77.5)
    try JSONEncoder().encode(p).write(to: URL(fileURLWithPath: r.home + "/auto-update/pending.json"))
    let u = r.updater(version: "1.4.0")
    u.tick()
    #expect(r.stopped.get().isEmpty, "never a signal to a process that is not the swap")
    #expect(r.posts.get().count == 1, "settled at once as stopped")
  }

  @Test func aRunKilledWithoutAResultIsPutBackByTheApp() throws {
    let r = try Rig()
    r.git(["fetch", "-q", "--tags", "origin"], in: r.checkout)
    r.git(["checkout", "-q", "--detach", r.b], in: r.checkout)
    try FileManager.default.createDirectory(atPath: r.home + "/auto-update", withIntermediateDirectories: true)
    let p = AutoUpdate.Pending(
      version: "1.5.0", old_version: "1.4.0", checkout: r.checkout, old_ref: "main", old_head: r.a, helper_pid: 999_999,
      started_at: ISOTime.string(Date().timeIntervalSince1970))
    try JSONEncoder().encode(p).write(to: URL(fileURLWithPath: r.home + "/auto-update/pending.json"))
    let u = r.updater(version: "1.4.0")
    u.tick()
    #expect(r.branch() == "main" && r.head() == r.a)
    #expect(r.posts.get() == ["Talos couldn't update to 1.5.0: the update stopped before it finished. It's still on 1.4.0."])
    u.tick()
    #expect(r.posts.get().count == 1, "settled once")
  }

  @Test func noPinnedKeyInstallsNothing() throws {
    let r = try Rig()
    try r.publish()
    var o = AutoUpdater.Options(talosHome: r.home, appPath: r.dest + "/Talos.app", appVersion: "1.4.0", keys: [])
    o.firstCheckAfter = 0
    o.auditLogPath = r.root + "/audit.log"
    let counted = Box(0)
    var h = AutoUpdater.Hooks(settings: { (true, nil) }, checkout: { nil }, look: { [] }, post: { _ in }, env: { [:] })
    h.fetch = { _, _, _ in
      counted.edit { $0 += 1 }
      return nil
    }
    AutoUpdater(options: o, hooks: h).tick()
    #expect(counted.get() == 0 && r.audit().contains("no_release_key"))
  }
}
