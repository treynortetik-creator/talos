import Darwin
import Foundation
import TalosDesktopCore

/// The updater's own look at the checkout and its git calls: the apply script's `--preflight` first, then hardened calls only
/// (`HardenedGit`), a fetch only from the public repository's address.
extension AutoUpdater {
  /// Where the script's own answer to a `--preflight` goes.
  var preflightPath: String { dir + "/preflight.json" }

  /// The apply script's copy, made afresh from the app's own (`Options.applyScript`). False when there is none or it could not be
  /// made: the checkout's own copy is never used, it is a file an agent can write.
  func stageScript(for co: String) -> Bool {
    guard let source = options.applyScript, FileManager.default.fileExists(atPath: source) else { return false }
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    try? FileManager.default.removeItem(atPath: scriptPath)
    guard (try? FileManager.default.copyItem(atPath: source, toPath: scriptPath)) != nil else { return false }
    chmod(scriptPath, 0o700)
    return true
  }

  /// The script to run now: the copy that ran, else the app's own. Never the checkout's.
  func applyScriptNow() -> String {
    [scriptPath, options.applyScript].compactMap { $0 }.first { FileManager.default.fileExists(atPath: $0) } ?? ""
  }

  /// The fixed environment of the apply script and of install.sh (`HardenedGit.scriptEnv`), from the login environment with the app's own
  /// bun last on its PATH. `testScriptEnv` adds what a test's stand-ins need. nil when there is no git.
  func applyEnv(deps: Bool) -> [String: String]? {
    guard let g = resolvedGit else { return nil }
    var base = hooks.env()
    if let p = BundledTools.appending(toPath: base["PATH"], dir: BundledTools.dir) { base["PATH"] = p }
    return HardenedGit.scriptEnv(from: base, git: g, deps: deps).merging(hooks.testScriptEnv()) { _, new in new }
  }

  /// One run of the apply script with a fixed environment (`HardenedGit.scriptEnv`) and the resolved git by full path (`--git`).
  /// `deps`: the mode installs packages (--prepare, --restore), so pnpm or bun are found after the system folders.
  func runApply(_ args: [String], deps: Bool, timeout: Double) -> RunResult {
    guard let g = resolvedGit, let env = applyEnv(deps: deps) else { return RunResult(status: 127, stdout: Data(), stderr: Data("no git".utf8), timedOut: false) }
    return hooks.run(["/bin/bash", applyScriptNow()] + args + ["--git", g], env, timeout)
  }

  /// nil: HEAD is the release's commit or in its history. Otherwise the way `--prepare` says it: the release is older than HEAD, or
  /// HEAD has commits of its own.
  func historyProblem(_ co: String, _ sha: String) -> AutoUpdate.Failure? {
    if gitRun(co, ["merge-base", "--is-ancestor", "HEAD", sha], timeout: 30)?.ok == true { return nil }
    if gitRun(co, ["merge-base", "--is-ancestor", sha, "HEAD"], timeout: 30)?.ok == true { return .olderRelease }
    return .localCommits
  }

  /// The release commit's own install.sh, written into `folder` (the updater's, 0700) as `install-check/scripts/install.sh`; nil when
  /// it could not be read. The app bundle does not carry install.sh, so this is the strongest copy there is.
  func extractInstallScript(_ co: String, _ sha: String, into folder: String) -> String? {
    guard let r = gitRun(co, ["show", sha + ":apps/desktop/scripts/install.sh"]), r.ok, !r.stdout.isEmpty else { return nil }
    let d = folder + "/install-check/scripts"
    guard (try? FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])) != nil
    else { return nil }
    let path = d + "/install.sh"
    guard (try? r.stdout.write(to: URL(fileURLWithPath: path))) != nil else { return nil }
    chmod(path, 0o700)
    return path
  }

  /// The apply script's `--preflight`, before any git call of this app's own in `co`: the checkout is a plain clone with nothing of
  /// its own changed. nil: fit. Otherwise why not, in the script's own word (exit 20); a script that could not run, or said nothing
  /// this app knows, is `.checkout`. The checks are the script's, not repeated here.
  func preflight(_ co: String) -> AutoUpdate.Failure? {
    try? FileManager.default.removeItem(atPath: preflightPath)
    let out = runApply(["--preflight", "--checkout", co, "--result", preflightPath], deps: false, timeout: options.gitTimeout)
    let res = readResult(preflightPath)
    if out.ok, res?.ok == true { return nil }
    audit("preflight_refused", ["exit": "\(out.status)", "why": res?.why ?? "none"])
    return res?.why.flatMap(AutoUpdate.Failure.init(rawValue:)) ?? .checkout
  }

  /// Whether git may read `co` for the way back: a checkout with changes of its own is still read (the way back does not need it
  /// clean); one that is not a plain clone is not.
  func readableForRestore(_ co: String) -> Bool {
    let why = preflight(co)
    return why == nil || why == .dirty
  }

  /// One hardened git call in `co` (`HardenedGit`); nil when there is no git to run.
  func gitRun(_ co: String, _ args: [String], timeout: Double? = nil) -> RunResult? {
    guard let g = resolvedGit else { return nil }
    return hooks.run(HardenedGit.argv(git: g, checkout: co, args: args), HardenedGit.env(from: hooks.env()), timeout ?? options.gitTimeout)
  }

  /// The release's commit in the checkout's object store, fetched from the public repository's own address if it is not there yet.
  func fetchCommit(_ co: String, _ sha: String) -> Bool {
    let has = { self.gitRun(co, ["cat-file", "-e", sha + "^{commit}"], timeout: 30)?.ok == true }
    if has() { return true }
    guard let g = resolvedGit else { return false }
    let schemes = HardenedGit.schemes(for: options.repoURL, allowLocal: options.allowLocalFeed)
    if schemes.isEmpty {
      audit("fetch_refused_address")
      return false
    }
    let env = HardenedGit.env(from: hooks.env())
    for (opts, what) in [(["--quiet"], [sha]), (["--quiet", "--tags"], [])] as [([String], [String])] {
      _ = hooks.run(
        HardenedGit.fetchArgv(git: g, checkout: co, url: options.repoURL, schemes: schemes, options: opts, refspecs: what), env,
        options.gitTimeout)
      if has() { return true }
    }
    return false
  }

  func git(_ co: String, _ args: [String]) -> String? {
    guard let r = gitRun(co, args), r.ok else { return nil }
    let s = r.out.trimmingCharacters(in: .whitespacesAndNewlines)
    return s.isEmpty ? nil : s
  }

  /// The checkout was moved to the release's code and then turned out to be untrusted: it is left alone, and the line says so.
  func refuseMoved(_ m: ReleaseManifest, pending: AutoUpdate.Pending?) {
    if var p = pending {  // the record is kept (the way back failed): marked, so the next look closes it without a second line
      p.moved_untrusted = true
      if let d = try? JSONEncoder().encode(p) { try? AtomicFile.write(d, to: pendingPath, mode: 0o600) }
    }
    audit("apply_refused", ["version": m.version, "why": AutoUpdate.Failure.checkoutConfig.rawValue])
    noteFailed(m.version)
    let line = AutoUpdate.movedAndUntrustedLine(m.version, old: options.appVersion ?? "this version")
    fail(line)
    sayOnce(m.version + "|moved-checkout-config", line)
  }
}
