import Foundation
import Testing
import TalosDesktopCore
import TalosTestSupport

@testable import TalosSupervisor

/// The updater's own git calls in the checkout (a folder an agent can write to): the apply script's --preflight first, then only
/// hardened calls, a fetch only from an explicit address, the release's commit named on every way back, and HEAD proved before the swap.
@Suite("Auto update: git in the checkout", .serialized)
struct UpdaterGitHardeningTests {
  typealias Rig = AutoUpdaterTests.Rig
  typealias Box = AutoUpdaterTests.Box

  struct Call: Sendable {
    var argv: [String]
    var env: [String: String]
    var isGit: Bool { (argv.first ?? "").hasSuffix("/git") }
  }

  /// An updater that records every command it runs (and runs it for real), unless `answer` gives the reply.
  static func recording(
    _ r: Rig, _ calls: Box<[Call]>, version: String = "1.4.0", options: (@Sendable (inout AutoUpdater.Options) -> Void)? = nil,
    answer: (@Sendable ([String]) -> RunResult?)? = nil
  ) -> AutoUpdater {
    r.updater(
      version: version, options: options,
      hooks: { h in
        let real = h.run
        h.run = { argv, env, t in
          calls.edit { $0.append(Call(argv: argv, env: env)) }
          return answer?(argv) ?? real(argv, env, t)
        }
      })
  }

  /// The checkout as a Mac that has not yet seen the release: the public repo's main only (over a real transfer, so only main's history comes), so B is not in it.
  static func withoutTheRelease(_ r: Rig) throws {
    try FileManager.default.removeItem(atPath: r.checkout)  // a folder inside this test's own temp root
    r.git(["clone", "-q", "--single-branch", "--branch", "main", TestTemp.fileURL(r.root + "/origin.git"), r.checkout])
    #expect(r.git(["cat-file", "-t", r.b], in: r.checkout) != "commit", "the release's commit is not in the checkout yet")
  }

  // MARK: the runner itself

  @Test func theRunnerSaysExactlyWhatGitIsToRunWithAndNothingOfTheOwnersEnvironment() {
    let argv = HardenedGit.argv(git: "/usr/bin/git", checkout: "/home/alex/talos", args: ["status", "--porcelain"])
    #expect(
      argv == [
        "/usr/bin/git", "-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null", "-c", "core.commitGraph=false", "-c", "core.alternateRefsCommand=", "-c",
        "maintenance.auto=false", "-c", "gc.auto=0",
        "--git-dir=/home/alex/talos/.git", "--work-tree=/home/alex/talos", "status", "--porcelain",
      ])
    // a hostile login environment: every variable that could steer git, a proxy to keep, a secret to drop
    let login: [String: String] = [
      "PATH": "/opt/bin:/usr/bin", "HOME": "/home/alex", "LANG": "en_US.UTF-8", "TMPDIR": "/home/alex/tmp", "HTTPS_PROXY": "http://proxy:3128",
      "GIT_DIR": "/elsewhere", "GIT_WORK_TREE": "/elsewhere", "GIT_SSH_COMMAND": "evil", "GIT_EXEC_PATH": "/evil", "GIT_CONFIG_COUNT": "1",
      "GIT_CONFIG_KEY_0": "core.fsmonitor", "GIT_CONFIG_VALUE_0": "evil", "GIT_ASKPASS": "evil", "XDG_CONFIG_HOME": "/home/alex/cfg",
      "GIT_CONFIG_GLOBAL": "/home/alex/.gitconfig", "GIT_CONFIG_SYSTEM": "/evil", "SSH_AUTH_SOCK": "/s", "TALOS_APP_WORKER_NONCE": "n",
      "OWNER_SECRET": "hunter2", "LD_PRELOAD": "/evil", "DYLD_INSERT_LIBRARIES": "/evil",
    ]
    #expect(
      HardenedGit.env(from: login) == [
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": "/home/alex", "LANG": "en_US.UTF-8", "LC_ALL": "C", "TMPDIR": "/home/alex/tmp",
        "HTTPS_PROXY": "http://proxy:3128", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_TERMINAL_PROMPT": "0",
        "GIT_NO_REPLACE_OBJECTS": "1", "GIT_ALTERNATE_OBJECT_DIRECTORIES": "",
      ])
    // nothing set: still a complete environment, never an empty PATH or a missing HOME
    let bare = HardenedGit.env(from: [:])
    #expect(bare["PATH"] == "/usr/bin:/bin:/usr/sbin:/sbin" && bare["HOME"] != nil && bare["GIT_CONFIG_GLOBAL"] == "/dev/null")
  }

  @Test func aFetchGoesToAnExplicitAddressOverHttpsOnlyWithNoHelper() {
    let argv = HardenedGit.fetchArgv(
      git: "/usr/bin/git", checkout: "/home/alex/talos", url: "https://github.com/example/talos", schemes: ["https"],
      options: ["--quiet"], refspecs: ["0123456789012345678901234567890123456789"])
    #expect(
      argv == [
        "/usr/bin/git", "-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null", "-c", "core.commitGraph=false", "-c", "core.alternateRefsCommand=", "-c",
        "maintenance.auto=false", "-c", "gc.auto=0", "-c", "protocol.allow=never",
        "-c", "protocol.https.allow=always", "-c", "credential.helper=", "-c", "core.askPass=", "-c", "core.sshCommand=",
        "--git-dir=/home/alex/talos/.git", "--work-tree=/home/alex/talos", "fetch", "--quiet", "--", "https://github.com/example/talos",
        "0123456789012345678901234567890123456789",
      ])
    #expect(!argv.contains("origin"))
  }

  @Test func onlyAPlainHttpsAddressMayBeFetchedFromAndALocalOneOnlyInATest() {
    #expect(HardenedGit.schemes(for: "https://github.com/example/talos", allowLocal: false) == ["https"])
    for bad in [
      "http://github.com/example/talos", "ssh://git@example.com/talos", "git@example.com:talos.git", "git://github.com/x",
      "https://user:pw@example.com/x", "https:///nohost", "ext::sh -c evil", "file:///home/alex/x", "/home/alex/x", "origin", "",
    ] {
      #expect(HardenedGit.schemes(for: bad, allowLocal: false).isEmpty, Comment(rawValue: bad))
    }
    #expect(HardenedGit.schemes(for: "/home/alex/x", allowLocal: true) == ["file"])
    #expect(HardenedGit.schemes(for: "ext::sh -c evil", allowLocal: true).isEmpty)
  }

  // MARK: the updater: preflight first, then hardened calls

  @Test func preflightRunsBeforeAnyGitCallAndEveryGitCallIsHardened() throws {
    let r = try Rig()
    try r.publish()
    let calls = Box<[Call]>([])
    let u = Self.recording(r, calls)
    r.driveToSwap(u)
    #expect(!r.spawns.get().isEmpty, "the update went all the way to its swap")
    let all = calls.get()
    let firstPreflight = try #require(all.firstIndex { $0.argv.contains("--preflight") })
    let firstGit = try #require(all.firstIndex { $0.isGit })
    #expect(firstPreflight < firstGit, "the apply script looked at the checkout before the first git call")
    #expect(all.filter { $0.argv.contains("--preflight") }.allSatisfy { $0.argv.contains(r.checkout) && $0.argv.contains("--result") })
    let gits = all.filter { $0.isGit }
    #expect(gits.count >= 3, "the head and branch reads, and the one before the swap: \(gits.count)")
    for c in gits {
      #expect(c.argv[0] == "/usr/bin/git" && c.argv.contains("--git-dir=" + r.checkout + "/.git") && c.argv.contains("--work-tree=" + r.checkout), "\(c.argv)")
      #expect(Array(c.argv[1...HardenedGit.hardening.count]) == HardenedGit.hardening, "\(c.argv)")
      #expect(c.env == HardenedGit.env(from: r.env), "the environment git got was built from nothing")
      #expect(!c.argv.contains("-C"))
    }
    #expect(!all.contains { $0.argv.first == "/usr/bin/env" }, "no git by name through env")
    // the old plain calls are gone: no status without the hardening
    #expect(gits.allSatisfy { $0.argv.contains("core.fsmonitor=") })
  }

  @Test func aCheckoutThatIsNotAPlainCloneStopsEveryGitCallAndNoProgramOfItsOwnRuns() throws {
    let r = try Rig()
    try r.publish()
    // an agent wrote an fsmonitor program into the checkout's own config: git would run it on `status`
    let marker = r.root + "/fsmonitor-ran"
    try r.write(r.root + "/evil.sh", "#!/bin/bash\ntouch '\(marker)'\nexit 0\n", mode: 0o755)
    r.git(["config", "core.fsmonitor", r.root + "/evil.sh"], in: r.checkout)
    let calls = Box<[Call]>([])
    Self.recording(r, calls).tick()
    #expect(calls.get().filter { $0.isGit }.isEmpty, "the preflight said 20, and no git call of the app's ran after it")
    #expect(calls.get().contains { $0.argv.contains("--preflight") })
    #expect(!FileManager.default.fileExists(atPath: marker), "the program in the checkout's config never ran")
    #expect(r.downloads.get() == 0)
    #expect(
      r.posts.get() == [
        "Talos couldn't update to 1.5.0: the Talos code folder has settings of its own that Talos does not trust, so it was left alone. It's still on 1.4.0."
      ], "\(r.posts.get())")
    #expect(r.audit().contains("preflight_refused") && r.audit().contains("why=checkout-config"))
  }

  /// The preflight's exit 20 and each why it can give, mapped to the owner's words (the script's own reasons are tested in
  /// auto-update-apply-test.sh; here the app's reading of them).
  @Test func eachPreflightRefusalIsMappedToPlainWordsAndStopsEverything() throws {
    let want: [(String, String)] = [
      ("checkout", "the Talos code folder could not be moved to the new version"),
      ("checkout-config", "the Talos code folder has settings of its own that Talos does not trust, so it was left alone"),
      ("dirty", "the Talos code folder has changes of its own"),
      ("local-commits", "the Talos code folder has changes of its own that are not in the new version"),
      ("older-release", "the new version is older than the Talos code folder"),
    ]
    for (why, words) in want {
      let r = try Rig()
      try r.publish()
      let calls = Box<[Call]>([])
      let u = Self.recording(r, calls, answer: { argv in
        guard argv.contains("--preflight"), let f = argv.firstIndex(of: "--result") else { return nil }
        try? Data("{\"v\":1,\"ok\":false,\"step\":\"preflight\",\"why\":\"\(why)\"}\n".utf8).write(to: URL(fileURLWithPath: argv[f + 1]))
        return RunResult(status: 20, stdout: Data(), stderr: Data(), timedOut: false)
      })
      u.tick()
      #expect(calls.get().filter { $0.isGit }.isEmpty, "\(why): no git call after a 20")
      #expect(r.downloads.get() == 0, Comment(rawValue: why))
      #expect(r.posts.get() == ["Talos couldn't update to 1.5.0: \(words). It's still on 1.4.0."], "\(why): \(r.posts.get())")
    }
    // a script that could not run at all, or said something this app does not know, is still a refusal in plain words
    for broken in [RunResult(status: 64, stdout: Data(), stderr: Data(), timedOut: false), RunResult(status: 0, stdout: Data(), stderr: Data(), timedOut: true)] {
      let r = try Rig()
      try r.publish()
      let calls = Box<[Call]>([])
      let u = Self.recording(r, calls, answer: { $0.contains("--preflight") ? broken : nil })
      u.tick()
      #expect(calls.get().filter { $0.isGit }.isEmpty && r.downloads.get() == 0)
      #expect(r.posts.get().first?.contains("could not be moved") == true, "\(r.posts.get())")
    }
  }

  // MARK: the fetch

  @Test func theReleasesCommitIsFetchedFromTheRepoAddressNeverFromOrigin() throws {
    let r = try Rig()
    try r.publish()
    try Self.withoutTheRelease(r)
    let calls = Box<[Call]>([])
    let u = Self.recording(r, calls)
    u.tick()
    let fetch = try #require(calls.get().first { $0.argv.contains("fetch") })
    #expect(
      fetch.argv == HardenedGit.fetchArgv(
        git: "/usr/bin/git", checkout: r.checkout, url: r.root + "/origin.git", schemes: ["file"], options: ["--quiet"], refspecs: [r.b]))
    #expect(!fetch.argv.contains("origin"))
    #expect(r.downloads.get() == 1, "the commit arrived and the update went on")
  }

  @Test func anAddressThatIsNotHttpsIsNeverFetchedFromInProduction() throws {
    for url in ["git@example.com:talos.git", "ssh://git@example.com/talos", "http://github.com/example/talos", "origin"] {
      let r = try Rig()
      try r.publish()
      try Self.withoutTheRelease(r)
      let calls = Box<[Call]>([])
      let u = Self.recording(r, calls, options: { $0.repoURL = url; $0.allowLocalFeed = true })
      u.tick()
      #expect(!calls.get().contains { $0.argv.contains("fetch") }, "\(url): nothing was fetched")
      #expect(r.downloads.get() == 0)
      #expect(r.posts.get() == ["Talos couldn't update to 1.5.0: the new version's code is not in the public repository yet. It's still on 1.4.0."], Comment(rawValue: url))
    }
  }

  @Test func theHttpsFetchAllowsHttpsAndNothingElse() throws {
    let r = try Rig()
    try r.publish()
    try Self.withoutTheRelease(r)
    let calls = Box<[Call]>([])
    let url = "https://github.com/example/talos"
    // the public address, and a commit the checkout does not have: the fetch is asked for (and answered with a failure here)
    let u = Self.recording(
      r, calls, options: { $0.repoURL = url },
      answer: { $0.contains("fetch") ? RunResult(status: 128, stdout: Data(), stderr: Data(), timedOut: false) : nil })
    u.tick()
    let fetches = calls.get().filter { $0.argv.contains("fetch") }
    #expect(fetches.count == 2, "the commit, then the tags")
    for f in fetches {
      #expect(f.argv.contains("protocol.allow=never") && f.argv.contains("protocol.https.allow=always") && !f.argv.contains("protocol.file.allow=always"))
      #expect(f.argv.contains("credential.helper=") && f.argv.contains("core.askPass=") && f.argv.contains("core.sshCommand="))
      #expect(f.argv.contains(url) && !f.argv.contains("origin"))
    }
    #expect(r.posts.get().first?.contains("not in the public repository yet") == true, "a failed fetch is said, not skipped: \(r.posts.get())")
  }

  @Test func thePrepareIsGivenTheRepoAddressAndTheCommit() throws {
    let r = try Rig()
    try r.publish()
    let calls = Box<[Call]>([])
    let u = Self.recording(r, calls)
    r.driveToSwap(u)
    let prep = try #require(calls.get().first { $0.argv.contains("--prepare") })
    let i = try #require(prep.argv.firstIndex(of: "--repo-url"))
    #expect(prep.argv[i + 1] == r.root + "/origin.git")
    #expect(prep.argv[try #require(prep.argv.firstIndex(of: "--commit")) + 1] == r.b)
  }

  // MARK: the way back names the release's commit

  @Test func theWayBackAfterABusyLastLookNamesTheReleasesCommit() throws {
    let r = try Rig()
    try r.publish()
    let calls = Box<[Call]>([])
    let u = Self.recording(r, calls)
    for _ in 0..<8 {
      if r.head() == r.b { break }
      u.tick()
      r.clock.edit { $0 += 30 }
    }
    #expect(r.head() == r.b)
    r.busy.set(["thread t_one busy"])
    u.tick()
    #expect(r.head() == r.a)
    let back = try #require(calls.get().first { $0.argv.contains("--restore") })
    #expect(back.argv[try #require(back.argv.firstIndex(of: "--commit")) + 1] == r.b)
    #expect(back.argv[try #require(back.argv.firstIndex(of: "--to")) + 1] == "main")
  }

  @Test func theWayBackAfterAStoppedRunNamesTheReleasesCommit() throws {
    let r = try Rig()
    r.git(["fetch", "-q", "--tags", "origin"], in: r.checkout)
    r.git(["checkout", "-q", "--detach", r.b], in: r.checkout)
    try FileManager.default.createDirectory(atPath: r.home + "/auto-update", withIntermediateDirectories: true)
    var p = AutoUpdate.Pending(
      version: "1.5.0", old_version: "1.4.0", checkout: r.checkout, old_ref: "main", old_head: r.a, helper_pid: 999_999,
      started_at: ISOTime.string(Date().timeIntervalSince1970))
    p.commit = r.b
    try JSONEncoder().encode(p).write(to: URL(fileURLWithPath: r.home + "/auto-update/pending.json"))
    let calls = Box<[Call]>([])
    Self.recording(r, calls).tick()
    #expect(r.branch() == "main" && r.head() == r.a)
    let back = try #require(calls.get().first { $0.argv.contains("--restore") })
    #expect(back.argv[try #require(back.argv.firstIndex(of: "--commit")) + 1] == r.b)
    let firstPreflight = try #require(calls.get().firstIndex { $0.argv.contains("--preflight") })
    #expect(firstPreflight < (calls.get().firstIndex { $0.isGit } ?? Int.max), "the preflight came before the app's own git reads")
  }

  @Test func aStoppedRunInACheckoutThatIsNoLongerAPlainCloneIsNotReadByGitAndSaysSo() throws {
    let r = try Rig()
    r.git(["fetch", "-q", "--tags", "origin"], in: r.checkout)
    r.git(["checkout", "-q", "--detach", r.b], in: r.checkout)
    let marker = r.root + "/fsmonitor-ran"
    try r.write(r.root + "/evil.sh", "#!/bin/bash\ntouch '\(marker)'\nexit 0\n", mode: 0o755)
    r.git(["config", "core.fsmonitor", r.root + "/evil.sh"], in: r.checkout)
    try FileManager.default.createDirectory(atPath: r.home + "/auto-update", withIntermediateDirectories: true)
    var p = AutoUpdate.Pending(
      version: "1.5.0", old_version: "1.4.0", checkout: r.checkout, old_ref: "main", old_head: r.a, helper_pid: 999_999,
      started_at: ISOTime.string(Date().timeIntervalSince1970))
    p.commit = r.b
    try JSONEncoder().encode(p).write(to: URL(fileURLWithPath: r.home + "/auto-update/pending.json"))
    let calls = Box<[Call]>([])
    Self.recording(r, calls).tick()
    #expect(calls.get().filter { $0.isGit }.isEmpty && !FileManager.default.fileExists(atPath: marker))
    #expect(r.audit().contains("restore exit=20 ok=0"), "the refused way back is in the log: \(r.audit())")
    #expect(r.posts.get().count == 1, "and the owner is told the update stopped")
  }

  // MARK: HEAD is the release's commit before the swap

  @Test func aCheckoutMovedOffTheReleasesCommitAfterThePrepareIsRefusedBeforeTheSwap() throws {
    let r = try Rig()
    try r.publish()
    let u = r.updater()
    for _ in 0..<8 {
      if r.head() == r.b { break }
      u.tick()
      r.clock.edit { $0 += 30 }
    }
    #expect(r.head() == r.b, "prepared")
    // between the prepare and the swap, something moves the checkout to another commit (a clean one: nothing else is wrong with it)
    r.git(["checkout", "-q", "--detach", r.a], in: r.checkout)
    for _ in 0..<6 where r.posts.get().filter({ $0.hasPrefix("Talos couldn't") }).isEmpty {
      u.tick()
      r.clock.edit { $0 += 30 }
    }
    #expect(r.spawns.get().isEmpty, "the swap never started")
    #expect(r.posts.get().filter { $0.hasPrefix("Talos couldn't") } == ["Talos couldn't update to 1.5.0: the Talos code folder could not be moved to the new version. It's still on 1.4.0."], "\(r.posts.get())")
    #expect(!FileManager.default.fileExists(atPath: r.home + "/auto-update/pending.json"), "nothing is left pending")
    #expect(r.head() == r.a)
  }

  @Test func aSwapIsStillStartedWhenTheCheckoutIsOnTheReleasesCommit() throws {
    let r = try Rig()
    try r.publish()
    let u = r.updater()
    r.driveToSwap(u)
    #expect(r.spawns.get().count == 1, "the swap started: the head read before it matched")
  }
}

extension UpdaterGitHardeningTests {
  /// Fakes of the tools the apply script finds through PATH, in a folder that comes FIRST on the owner's login PATH (as ~/.local/bin or
  /// /opt/homebrew/bin could): each leaves a mark and then does the real tool's job.
  static func hijackFolder(_ r: Rig) throws -> (dir: String, marker: String) {
    let dir = r.root + "/hijack"
    let marker = r.root + "/hijack-ran"
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    for tool in ["env", "grep", "mktemp", "git", "sed", "cat", "mv", "date", "ls", "rm", "awk", "ps", "sleep", "seq", "tr", "cut", "stat", "cp", "mkdir", "chmod", "dirname", "basename", "wc"] {
      try r.write(dir + "/" + tool, "#!/bin/bash\necho \(tool) >> '\(marker)'\nfor d in /usr/bin /bin; do [ -x \"$d/\(tool)\" ] && exec \"$d/\(tool)\" \"$@\"; done\nexit 127\n", mode: 0o755)
    }
    return (dir, marker)
  }

  // MARK: R1-1: the apply script runs with a fixed environment

  @Test func theApplyScriptNeverFindsItsToolsThroughTheLoginPath() throws {
    let r = try Rig()
    try r.publish()
    let (dir, marker) = try Self.hijackFolder(r)
    r.extraEnv.set(["PATH": dir + ":" + r.stub + ":/usr/bin:/bin:/usr/sbin:/sbin"])
    // the control: the same script run the old way (the login environment) does find them, so the folder really is a hijack
    let control = ProcessRunner.run(
      ["/bin/bash", AutoUpdaterTests.repo() + "/apps/desktop/scripts/auto-update-apply.sh", "--preflight", "--checkout", r.checkout, "--result", r.root + "/c.json"],
      env: r.env, timeout: 60)
    #expect(control.ok && FileManager.default.fileExists(atPath: marker), "the hijacked tools run under the login PATH: \(control.err)")
    try FileManager.default.removeItem(atPath: marker)
    let calls = Box<[Call]>([])
    let u = Self.recording(r, calls)
    for _ in 0..<8 {
      if r.head() == r.b { break }
      u.tick()
      r.clock.edit { $0 += 30 }
    }
    #expect(r.head() == r.b, "prepared")
    r.busy.set(["thread t_one busy"])
    u.tick()  // the way back (--restore)
    #expect(r.head() == r.a)
    #expect(!FileManager.default.fileExists(atPath: marker), "no fake env, grep, mktemp or git ran: \((try? String(contentsOfFile: marker, encoding: .utf8)) ?? "")")
    let applies = calls.get().filter { $0.argv.contains("--preflight") || $0.argv.contains("--prepare") || $0.argv.contains("--restore") }
    #expect(applies.count >= 3)
    for c in applies {
      let path = (c.env["PATH"] ?? "").split(separator: ":").map(String.init)
      #expect(Array(path.prefix(4)) == ["/usr/bin", "/bin", "/usr/sbin", "/sbin"], "\(c.argv)")
      #expect(!path.prefix(4).contains(dir))
      #expect(c.argv.suffix(2) == ["--git", "/usr/bin/git"], "git by full path: \(c.argv)")
    }
    for c in applies where c.argv.contains("--preflight") {
      #expect(c.env["PATH"] == "/usr/bin:/bin:/usr/sbin:/sbin", "the preflight needs nothing of the login PATH")
    }
  }

  /// The script itself, run with a PATH that leads with fakes of every system tool it uses: in preflight, prepare and restore not one fires.
  @Test func theApplyScriptTakesItsSystemToolsByFullPathNotThroughPath() throws {
    let r = try Rig()
    let (dir, marker) = try Self.hijackFolder(r)
    let script = AutoUpdaterTests.repo() + "/apps/desktop/scripts/auto-update-apply.sh"
    var env = r.env
    env["PATH"] = dir + ":" + r.stub + ":/usr/bin:/bin:/usr/sbin:/sbin"
    func run(_ args: [String]) -> RunResult {
      ProcessRunner.run(["/bin/bash", script] + args + ["--checkout", r.checkout, "--result", r.root + "/s.json", "--git", "/usr/bin/git"], env: env, timeout: 120)
    }
    let pre = run(["--preflight"])
    #expect(pre.ok, "\(pre.err)\(pre.out)")
    let prep = run(["--prepare", "--commit", r.b, "--repo-url", r.root + "/origin.git"])
    #expect(prep.ok && r.head() == r.b, "\(prep.err)\(prep.out)")
    let back = run(["--restore", "--commit", r.b, "--to", "main"])
    #expect(back.ok && r.head() == r.a, "\(back.err)\(back.out)")
    #expect(!FileManager.default.fileExists(atPath: marker), "a fake tool ran: \((try? String(contentsOfFile: marker, encoding: .utf8)) ?? "")")
    // the control: the same fakes do fire for a tool the script does not pin (so the folder really leads the PATH)
    let probe = ProcessRunner.run(["/bin/bash", "-c", "ls >/dev/null"], env: env, timeout: 30)
    #expect(probe.ok && FileManager.default.fileExists(atPath: marker), "the hijack folder leads PATH")
  }

  // MARK: R2-1: install.sh --check-only and the swap run in the fixed environment too

  @Test func theZipCheckAndTheSwapNeverFindDirnameOrGrepThroughTheLoginPath() throws {
    // the whole update, the swap included, with fakes first on the login PATH
    let r = try Rig()
    try r.publish()
    let (dir, marker) = try Self.hijackFolder(r)
    r.extraEnv.set(["PATH": dir + ":" + r.stub + ":/usr/bin:/bin:/usr/sbin:/sbin"])
    let calls = Box<[Call]>([])
    let u = Self.recording(r, calls)
    r.driveToSwap(u)
    #expect(r.spawns.get().count == 1, "the swap ran")
    #expect(r.log().contains("install B --from-release") && r.log().contains("open "), "the stand-ins ran: \(r.log())")
    #expect(!FileManager.default.fileExists(atPath: marker), "a fake ran: \((try? String(contentsOfFile: marker, encoding: .utf8)) ?? "")")
    for c in calls.get() where c.argv.contains("--check-only") {
      #expect((c.env["PATH"] ?? "").hasPrefix("/usr/bin:/bin:/usr/sbin:/sbin"), "\(c.env["PATH"] ?? "")")
    }
    #expect(r.spawns.get()[0].count > 3)
    // the real install.sh: its first line calls dirname by name, so the fake would fire if the login PATH led
    let q = try Rig()
    try FileManager.default.removeItem(atPath: q.checkout)
    try FileManager.default.removeItem(atPath: q.root + "/origin.git")
    try FileManager.default.removeItem(atPath: q.root + "/src")
    try q.makeRepo(realInstallSh: true)
    try q.publish()
    let (qdir, qmarker) = try Self.hijackFolder(q)
    q.extraEnv.set(["PATH": qdir + ":" + q.stub + ":/usr/bin:/bin:/usr/sbin:/sbin"])
    let control = ProcessRunner.run(["/bin/bash", AutoUpdaterTests.repo() + "/apps/desktop/scripts/install.sh", "--check-only"], env: q.env, timeout: 30)
    _ = control
    #expect(FileManager.default.fileExists(atPath: qmarker), "under the login PATH the fake dirname runs")
    try FileManager.default.removeItem(atPath: qmarker)
    Self.recording(q, Box<[Call]>([])).tick()
    #expect(!q.posts.get().isEmpty, "the real install.sh refused the fake zip")
    #expect(!FileManager.default.fileExists(atPath: qmarker), "no fake ran in the real check: \((try? String(contentsOfFile: qmarker, encoding: .utf8)) ?? "")")
  }

  /// The updater runs every command through `ProcessRunner` (pipes, never a terminal), so what it can leave behind is a process. The
  /// pids are the ones the updater's own hooks started (`Rig.pids`), not every child of the test process: other suites run beside
  /// this one, and their children and terminals are theirs. A terminal count cannot be scoped to the updater, so it is not made here.
  @Test func theUpdaterLeavesNoChildBehind() throws {
    let r = try Rig()
    try r.publish()
    let u = r.updater()
    r.driveToSwap(u)  // check, fetch, preflights, prepare, swap: every script and git call of an update
    #expect(r.spawns.get().count == 1)
    let pids = r.pids.get()
    #expect(!pids.isEmpty, "the updater ran commands through the hook")
    func gone(_ pid: Int32) -> Bool { kill(pid, 0) == -1 && errno == ESRCH }
    func groupEmpty(_ pid: Int32) -> Bool {
      ProcessRunner.run(["/usr/bin/pgrep", "-g", "\(pid)"], timeout: 10).out.split(separator: "\n").isEmpty
    }
    // the runner returns once its child has gone; a grandchild in its group may take a moment more
    var left = pids.filter { !gone($0) || !groupEmpty($0) }
    for _ in 0..<10 where !left.isEmpty {
      Thread.sleep(forTimeInterval: 0.5)
      left = left.filter { !gone($0) || !groupEmpty($0) }
    }
    #expect(left.isEmpty, "the updater left processes (or their groups) running: \(left)")
  }

  @Test func theScriptEnvironmentIsBuiltFromNothing() {
    let login: [String: String] = [
      "PATH": "/home/alex/.local/bin:/opt/homebrew/bin:/usr/bin", "HOME": "/home/alex", "LANG": "en_US.UTF-8", "TMPDIR": "/home/alex/tmp",
      "HTTPS_PROXY": "http://proxy:3128", "GIT_DIR": "/elsewhere", "OWNER_SECRET": "hunter2", "TALOS_JS_RUNTIME": "bun", "DYLD_INSERT_LIBRARIES": "/evil",
    ]
    #expect(
      HardenedGit.scriptEnv(from: login, git: "/usr/bin/git", deps: false) == [
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": "/home/alex", "LANG": "en_US.UTF-8", "TMPDIR": "/home/alex/tmp",
      ])
    #expect(
      HardenedGit.scriptEnv(from: login, git: "/opt/homebrew/bin/git", deps: true) == [
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/home/alex/.local/bin", "HOME": "/home/alex", "LANG": "en_US.UTF-8",
        "TMPDIR": "/home/alex/tmp", "HTTPS_PROXY": "http://proxy:3128", "TALOS_JS_RUNTIME": "bun",
      ], "packages are found after every system folder; nothing else of the login environment comes along")
  }

  // MARK: R1-2: alternates, maintenance and gc

  /// `p` as one shell word (single quotes, an embedded quote closed and reopened).
  static func shellQuotedPath(_ p: String) -> String { "'" + p.replacingOccurrences(of: "'", with: "'\\''") + "'" }

  @Test func aFetchNeverRunsTheCheckoutsAlternateRefsCommand() throws {
    func shellQuoted(_ p: String) -> String { Self.shellQuotedPath(p) }
    let root = try TestTemp.real(TestTemp.base) + "/talos-au-\(UUID().uuidString.prefix(8))"
    try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(atPath: root) }
    let clean: [String: String] = [
      "PATH": "/usr/bin:/bin", "HOME": root, "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1", "GIT_AUTHOR_NAME": "t",
      "GIT_AUTHOR_EMAIL": "t@example.com", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com",
    ]
    func git(_ args: [String]) -> RunResult { ProcessRunner.run(["/usr/bin/git"] + args, env: clean, timeout: 60) }
    let src = root + "/src", other = root + "/other", co = root + "/co"
    for d in [src, other] {
      #expect(git(["init", "-q", "-b", "main", d]).ok)
      #expect(git(["-C", d, "commit", "-q", "--allow-empty", "-m", d]).ok)
    }
    #expect(git(["init", "-q", "-b", "main", co]).ok)
    // planted after any preflight: another repository's objects as alternates, and the program git runs to list that repository's refs
    let marker = root + "/alt-ran"
    try Data("#!/bin/bash\ntouch \(shellQuoted(marker))\n".utf8).write(to: URL(fileURLWithPath: root + "/alt.sh"))
    chmod(root + "/alt.sh", 0o755)
    try FileManager.default.createDirectory(atPath: co + "/.git/objects/info", withIntermediateDirectories: true)
    try Data((other + "/.git/objects\n").utf8).write(to: URL(fileURLWithPath: co + "/.git/objects/info/alternates"))
    #expect(git(["-C", co, "config", "core.alternateRefsCommand", shellQuoted(root + "/alt.sh")]).ok)
    // the control: a plain fetch does run it, so the plant works
    #expect(git(["-C", co, "-c", "protocol.file.allow=always", "fetch", "-q", TestTemp.fileURL(src), "main"]).ok)
    // git runs that value through a shell, so a path with a space must be quoted; a control that did not run must STOP the test, not
    // let the hardened half pass for a command that never could have run
    try #require(FileManager.default.fileExists(atPath: marker), "a plain fetch runs core.alternateRefsCommand (the control did not run: the plant is broken)")
    try FileManager.default.removeItem(atPath: marker)
    let argv = HardenedGit.fetchArgv(git: "/usr/bin/git", checkout: co, url: TestTemp.fileURL(src), schemes: ["file"], options: ["--quiet"], refspecs: ["main"])
    let res = ProcessRunner.run(argv, env: HardenedGit.env(from: ["HOME": root]), timeout: 60)
    #expect(res.ok, "\(res.err)")
    #expect(!FileManager.default.fileExists(atPath: marker), "the hardened fetch never ran it")
    // and the script's own g() carries the same switches
    let script = try String(contentsOfFile: AutoUpdaterTests.repo() + "/apps/desktop/scripts/auto-update-apply.sh", encoding: .utf8)
    for flag in ["core.alternateRefsCommand=", "maintenance.auto=false", "gc.auto=0"] { #expect(script.contains("-c " + flag), Comment(rawValue: flag)) }
    #expect(HardenedGit.env(from: [:])["GIT_ALTERNATE_OBJECT_DIRECTORIES"] == "")
  }

  // MARK: R1-3: a way back that failed is kept for another try

  @Test func aPreSwapRefusalWhoseWayBackFailsKeepsTheRecordAndSaysHowToPutItBack() throws {
    let r = try Rig()
    try r.publish()
    let u = r.updater()
    for _ in 0..<8 {
      if r.head() == r.b { break }
      u.tick()
      r.clock.edit { $0 += 30 }
    }
    #expect(r.head() == r.b, "prepared")
    let pending = r.home + "/auto-update/pending.json"
    #expect(FileManager.default.fileExists(atPath: pending))
    // something gives the checkout a setting of its own: the swap is refused, and the way back is refused too
    r.git(["config", "core.pager", "evil"], in: r.checkout)
    for _ in 0..<2 where r.posts.get().filter({ $0.hasPrefix("Talos couldn") }).isEmpty {
      u.tick()
      r.clock.edit { $0 += 30 }
    }
    #expect(r.spawns.get().isEmpty, "the swap never started")
    #expect(r.posts.get().filter { $0.hasPrefix("Talos couldn") } == [AutoUpdate.movedAndUntrustedLine("1.5.0", old: "1.4.0")], "\(r.posts.get())")
    #expect(FileManager.default.fileExists(atPath: pending), "the record stays: the next look tries the way back again")
    #expect(r.audit().contains("restore exit=20 ok=0"))
    #expect(r.head() == r.b, "the files are on the new version's code, as the line says")
    // the owner has been told: the record is marked, and the next look closes it with no second line and no second restore
    let before = r.audit().components(separatedBy: "restore exit=").count
    let said = r.posts.get().count
    u.tick()
    #expect(r.audit().contains("moved_untrusted_closed"))
    #expect(r.audit().components(separatedBy: "restore exit=").count == before, "no second restore")
    #expect(r.posts.get().count == said, "nothing more is said: \(r.posts.get())")
    #expect(!FileManager.default.fileExists(atPath: pending), "the record is closed")
    u.tick()
    #expect(r.posts.get().count == said)
  }

  @Test func theMovedFolderLineIsPlainWords() {
    let line = AutoUpdate.movedAndUntrustedLine("1.5.0", old: "1.4.0")
    #expect(MacWords.forbiddenWords(in: line).isEmpty && line.contains("move that folder aside") && line.contains("1.5.0") && line.contains("1.4.0"))
  }

  // MARK: R1-4: the check step trusts only the release's own install.sh, and only for a checkout whose history fits

  @Test func aCheckoutWithCommitsOfItsOwnIsRefusedBeforeAnyInstallShRuns() throws {
    let r = try Rig()
    try r.publish()
    r.git(["commit", "-q", "--allow-empty", "-m", "mine"], in: r.checkout)
    let calls = Box<[Call]>([])
    Self.recording(r, calls).tick()
    #expect(r.posts.get() == ["Talos couldn't update to 1.5.0: the Talos code folder has changes of its own that are not in the new version. It's still on 1.4.0."], "\(r.posts.get())")
    #expect(!calls.get().contains { $0.argv.contains("--check-only") } && !r.log().contains("install "), "no install.sh ran")
    #expect(!FileManager.default.fileExists(atPath: r.home + "/auto-update/1.5.0"), "the download is gone")
  }

  @Test func aCheckoutAheadOfTheReleaseIsRefusedAsOlder() throws {
    let r = try Rig()
    try r.publish()
    r.git(["fetch", "-q", "--tags", "origin"], in: r.checkout)
    r.git(["checkout", "-q", "--detach", r.b], in: r.checkout)
    r.git(["commit", "-q", "--allow-empty", "-m", "after the release"], in: r.checkout)
    let calls = Box<[Call]>([])
    Self.recording(r, calls).tick()
    #expect(r.posts.get() == ["Talos couldn't update to 1.5.0: the new version is older than the Talos code folder. It's still on 1.4.0."], "\(r.posts.get())")
    #expect(!calls.get().contains { $0.argv.contains("--check-only") })
  }

  @Test func theZipIsCheckedByTheReleaseCommitsInstallShNotTheCheckouts() throws {
    let r = try Rig()
    try r.publish()
    let calls = Box<[Call]>([])
    let u = Self.recording(r, calls)
    u.tick()
    let check = try #require(calls.get().first { $0.argv.contains("--check-only") })
    #expect(check.argv[1] == r.home + "/auto-update/1.5.0/install-check/scripts/install.sh", "\(check.argv)")
    #expect(!check.argv[1].hasPrefix(r.checkout), "never the checkout's own file")
    #expect(r.log().contains("install B --from-release") && !r.log().contains("install A"), "it is the release's script: \(r.log())")
  }

  // MARK: R1-5: the checkout's own script is never run

  @Test func noAppScriptMeansNoUpdateAndTheCheckoutsCopyIsNeverRun() throws {
    for script in [nil, "/home/alex/no-such-script.sh"] as [String?] {
      let r = try Rig()
      try r.publish()
      // the checkout does hold a script of its own at the usual place: it must not be the fallback
      try FileManager.default.createDirectory(atPath: r.checkout + "/apps/desktop/scripts", withIntermediateDirectories: true)
      let theirs = r.root + "/their-script-ran"
      try r.write(r.checkout + "/apps/desktop/scripts/auto-update-apply.sh", "#!/bin/bash\ntouch '\(theirs)'\nexit 0\n", mode: 0o755)
      let calls = Box<[Call]>([])
      let u = Self.recording(r, calls, options: { $0.applyScript = script })
      u.tick()
      #expect(r.posts.get() == ["Talos couldn't update to 1.5.0: the new app could not be put in place. It's still on 1.4.0."], "\(script ?? "nil"): \(r.posts.get())")
      #expect(calls.get().isEmpty, "nothing ran, git included")
      #expect(!FileManager.default.fileExists(atPath: theirs), "the checkout's copy never ran")
      #expect(r.downloads.get() == 0)
    }
  }
}

/// The first setup's own git calls: a folder that was already there is read by git only after the apply script's --preflight, and the
/// download being checked is built by hardened calls from an explicit address.
@Suite("Auto clone: git in the folder", .serialized, .enabled(if: AutoCloneWorld.git != nil))
struct CloneGitHardeningTests {
  @Test func theDownloadIsBuiltByHardenedCallsFromTheRepoAddressWithWholeHistory() throws {
    let w = try AutoCloneWorld()
    defer { w.cleanUp() }
    #expect(w.provisioner({ w.viaArchive(&$0) }).run() == .ok(clone: w.dest))
    let log = (try String(contentsOfFile: w.home + "/git.log", encoding: .utf8)).split(separator: "\n").filter { $0.hasPrefix("git ") }
    let fetch = try #require(log.first { $0.contains(" fetch ") })
    #expect(fetch.contains("-c protocol.allow=never") && fetch.contains("-c credential.helper=") && fetch.contains("-c core.sshCommand="))
    #expect(fetch.contains(" -- " + w.url + " ") && !fetch.contains(" origin "), "by address, not by the folder's own remote: \(fetch)")
    #expect(!fetch.contains("--depth"), "a shallow checkout is one the update's preflight refuses")
    for line in log where line.contains("--git-dir=") || line.contains(" init ") {
      #expect(line.contains("-c core.fsmonitor= -c core.hooksPath=/dev/null -c core.commitGraph=false"), "\(line)")
    }
    #expect(log.contains { $0.contains("--git-dir=" + w.dest) || $0.contains("--git-dir=") }, "the later calls name the repository outright")
    // what it built is a plain clone: the apply script's own preflight accepts it
    let out = ProcessRunner.run(
      ["/bin/bash", AutoCloneWorld.applyScriptPath, "--preflight", "--checkout", w.dest, "--result", w.home + "/pf.json"],
      env: ["PATH": "/usr/bin:/bin", "HOME": w.home, "GIT_CONFIG_GLOBAL": "/dev/null"], timeout: 60)
    #expect(out.ok, "\(out.err)\(out.out)")
  }

  @Test func aFolderAlreadyThereIsNotReadByGitWhenItsPreflightRefuses() throws {
    let w = try AutoCloneWorld()
    defer { w.cleanUp() }
    #expect(w.provisioner({ w.viaArchive(&$0) }).run() == .ok(clone: w.dest))
    // an agent plants an fsmonitor program in the clone's own config, then the setup runs again
    let marker = w.home + "/fsmonitor-ran"
    try Data("#!/bin/bash\ntouch '\(marker)'\nexit 0\n".utf8).write(to: URL(fileURLWithPath: w.home + "/evil.sh"))
    chmod(w.home + "/evil.sh", 0o755)
    _ = try w.git(["-C", w.dest, "config", "core.fsmonitor", w.home + "/evil.sh"])
    try? FileManager.default.removeItem(atPath: w.home + "/git.log")
    guard case .failed(.clone, let why) = w.provisioner({ w.viaArchive(&$0) }).run() else { Issue.record("expected the folder to be refused"); return }
    #expect(why.contains("already exists") && why.contains("move it aside"), "\(why)")
    #expect(w.gitCalls(containing: " rev-parse ") == 0, "no git read of it")
    #expect(!FileManager.default.fileExists(atPath: marker), "the program never ran")
  }

  @Test func aFolderAlreadyThereWithNoScriptToCheckItIsNeverReused() throws {
    let w = try AutoCloneWorld()
    defer { w.cleanUp() }
    #expect(w.provisioner({ w.viaArchive(&$0) }).run() == .ok(clone: w.dest))
    try? FileManager.default.removeItem(atPath: w.home + "/git.log")
    guard case .failed(.clone, _) = w.provisioner({ w.viaArchive(&$0); $0.preflightScript = nil }).run() else { Issue.record("expected a refusal"); return }
    #expect(w.gitCalls(containing: " rev-parse ") == 0)
  }
}

extension AutoCloneWorld {
  static var applyScriptPath: String { CloneProvisioner.Config.testApplyScript }
}

extension CloneProvisioner.Config {
  static var testApplyScript: String {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("scripts/auto-update-apply.sh").path
  }
}
