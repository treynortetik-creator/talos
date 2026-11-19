import Foundation
import TalosDesktopCore

/// Gets the Talos code a prebuilt app needs onto this Mac with no question asked: the public repository, at the tag this app was
/// released from (so the app and its clone match), in a fixed folder, with Claude Code and the packages installed if they are
/// missing, and the record the app reads written last. Apple's developer tools come first (git needs them); the code is pinned to
/// the commit stamped in the signed app. Blocking and pure of UI; the app runs it off the main thread and shows each step.
///
/// Rules it keeps: git by full path with a clean environment and no prompt; https only (a test may widen the list); the clone is
/// made in a staging folder and renamed into place, so a failure at any point leaves nothing half-done and two runs at once have
/// one winner; the record exists only when every earlier step passed; it never deletes anything it did not make itself.
public struct CloneProvisioner: Sendable {
  public enum Step: String, CaseIterable, Sendable {
    case developerTools, lookup, clone, verify, claude, prerequisites, dependencies, record

    public var title: String {
      switch self {
      case .developerTools: return "Apple's developer tools"
      case .lookup: return "Finding this version of Talos"
      case .clone: return "Downloading Talos"
      case .verify: return "Checking the download"
      case .claude: return "Setting up Claude Code"
      case .prerequisites: return "Checking what Talos needs on this Mac"
      case .dependencies: return "Installing Talos's packages"
      case .record: return "Remembering where it is"
      }
    }
  }

  public enum State: Equatable, Sendable {
    case running
    /// Waiting on something outside Talos (the text is for the screen: what the owner has to do).
    case waiting(String)
    case done
    case failed(String)
  }

  public enum Result: Equatable, Sendable {
    case ok(clone: String)
    case failed(step: Step, message: String)
  }

  public struct Config: Sendable {
    /// The public repository. Anything but https is refused (`allowedSchemes`).
    public var repoURL = CloneProvisioner.publicRepo
    public var allowedSchemes: Set<String> = ["https"]
    /// This app's version (`CFBundleShortVersionString`); the tag is `mac-v<version>`.
    public var version: String?
    /// Where the clone ends up, and the record file (written last).
    public var destination: String
    public var recordFile: String
    /// Full path of a git that can run (never the Command Line Tools stub), nil when there is none.
    public var git: String?
    /// `xcode-select` by full path: `-p` says whether the Command Line Tools are installed, `--install` asks macOS to install them
    /// (its own dialog). Nothing that needs them (git, python3) runs before `-p` succeeds: without them even /usr/bin/git opens a dialog.
    public var xcodeSelect = "/usr/bin/xcode-select"
    /// Whether Apple's installer is still on screen or running, to tell "the owner closed it" from "still installing".
    public var installerRunning: @Sendable () -> Bool = { CloneProvisioner.appleInstallerRunning() }
    /// How often the tools are looked for while macOS installs them, and how long to wait (the download is the slow part).
    public var toolsPollInterval: Double = 3
    public var toolsTimeout: Double = 30 * 60
    /// Where git is looked for once the tools are there; `git` below overrides it (a test).
    public var findGit: @Sendable () -> String? = { CloneProvisioner.findGit(cltInstalled: true, isExecutable: FileManager.default.isExecutableFile) }
    /// The commit this release was made from on the public repository (the snapshot commit `mac-v<version>` names), stamped into the
    /// app's Info.plist (`TalosSourceCommit`) before it is signed. The tag GitHub answers with, and the clone's HEAD, must both be it:
    /// the code is pinned by the signed app, not by what GitHub says today. nil (a development build): auto-setup refuses.
    public var expectedCommit: String?
    /// sha256 of the source tarball Talos's own release published for this version (`talos-source-<tag>.tar.gz`, a release asset made
    /// by release-app.sh), stamped into Info.plist (`TalosSourceSHA256`) beside the commit. When present it is THE route for first setup:
    /// downloaded over https, checked against this hash before it is unpacked. GitHub's own archive bytes are not guaranteed stable;
    /// this asset is ours. Absent: the git route (pinned to `expectedCommit`).
    public var expectedSourceSHA256: String?
    /// Where release assets are: `<base>/<tag>/talos-source-<tag>.tar.gz`. https in production.
    public var sourceBase = CloneProvisioner.publicReleases
    public var curl = "/usr/bin/curl"
    public var tar = "/usr/bin/tar"
    /// bun, for the packages when there is no pnpm (the app's own bundled one included).
    public var bun: String?
    /// Whether Claude Code is on this Mac; false runs `claudeInstaller`. nil: not checked (a test).
    public var claudeFound: (@Sendable () -> Bool)?
    public var claudeInstaller: ClaudeInstaller?
    /// pnpm's full path, nil when not found.
    public var pnpm: String?
    /// The environment the tools run in (the login shell's PATH and proxy settings). Git gets only the parts it needs.
    public var env: [String: String]
    public var gitTimeout: Double = 300
    public var installTimeout: Double = 1800

    public init(
      version: String?, destination: String, recordFile: String, git: String?, pnpm: String?, env: [String: String]
    ) {
      self.version = version
      self.destination = destination
      self.recordFile = recordFile
      self.git = git
      self.pnpm = pnpm
      self.env = env
    }
  }

  public static let publicRepo = "https://github.com/treynortetik-creator/talos"
  public static let publicReleases = "https://github.com/treynortetik-creator/talos/releases/download"
  public static let tagPrefix = "mac-v"
  /// The file the archive route leaves in the copy: the commit the app was released from.
  static let commitMarker = ".talos-commit"

  let config: Config
  public init(_ config: Config) { self.config = config }

  /// `mac-v0.1.4` for "0.1.4"; nil for anything that is not a plain release number (a dev build says "dev").
  public static func tag(forVersion v: String?) -> String? {
    guard let v, v.range(of: #"^[0-9]+(\.[0-9]+){1,3}$"#, options: .regularExpression) != nil else { return nil }
    return tagPrefix + v
  }

  /// The git to run: /usr/bin/git only when the Command Line Tools are installed (without them it is a stub that opens an install
  /// dialog), else Homebrew's. nil when none.
  public static func findGit(cltInstalled: Bool, isExecutable: (String) -> Bool) -> String? {
    var candidates = ["/opt/homebrew/bin/git", "/usr/local/bin/git"]
    if cltInstalled { candidates.insert("/usr/bin/git", at: 0) }
    return candidates.first(where: isExecutable)
  }

  /// Whether the Command Line Tools are installed (`xcode-select -p` finds a developer folder).
  public static func commandLineToolsInstalled() -> Bool {
    ProcessRunner.run(["/usr/bin/xcode-select", "-p"], timeout: 10).ok
  }

  /// A refusal for a repository address that is not an allowed https one; nil when it may be used.
  static func urlProblem(_ url: String, allowed: Set<String>) -> String? {
    guard let c = URLComponents(string: url), let scheme = c.scheme?.lowercased(), allowed.contains(scheme) else {
      return "The Talos repository address (\(url)) is not an https address, so Talos will not use it."
    }
    if scheme != "file", (c.host ?? "").isEmpty || c.user != nil || c.password != nil {
      return "The Talos repository address (\(url)) is not a plain https address, so Talos will not use it."
    }
    return nil
  }

  /// The environment git runs in: the owner's PATH and proxy settings, nothing else of theirs. No prompt, no user or system git
  /// config (an `insteadOf` there could turn https into something else), and no GIT_* variable that points git at another repo.
  func gitEnv() -> [String: String] {
    var e: [String: String] = [
      "HOME": config.env["HOME"] ?? NSHomeDirectory(), "PATH": config.env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin",
      "GIT_TERMINAL_PROMPT": "0", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1", "LC_ALL": "C",
      "GIT_ASKPASS": "/usr/bin/false", "SSH_ASKPASS": "/usr/bin/false",
    ]
    for k in ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR"] {
      if let v = config.env[k] { e[k] = v }
    }
    return e
  }

  func gitArgs(_ rest: [String]) -> [String] {
    var a = ["-c", "protocol.allow=never"]
    for s in config.allowedSchemes { a += ["-c", "protocol.\(s).allow=always"] }
    return a + ["-c", "advice.detachedHead=false"] + rest
  }

  /// The last lines git or a script said, for a message.
  static func said(_ r: RunResult) -> String {
    let lines = (r.err + "\n" + r.out).split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    return lines.suffix(4).joined(separator: "\n")
  }

  // MARK: run

  /// Whether the Command Line Tools are installed, asked of `xcode-select -p` (it never opens a dialog).
  func toolsPresent() -> Bool { ProcessRunner.run([config.xcodeSelect, "-p"], timeout: 15).ok }

  /// Whether Apple's "Install Command Line Developer Tools" program is running (by name in the process list, never `pkill`/`pgrep -f`).
  static func appleInstallerRunning() -> Bool {
    ProcessRunner.run(["/bin/ps", "-axco", "command"], timeout: 10).out.contains("Install Command Line Developer Tools")
  }

  /// Step 0: the Command Line Tools. Absent: macOS is asked, once, to install them (`xcode-select --install`) and the tools are polled
  /// for until they are there; closing Apple's window, or the timeout, is a failure the owner can retry (which asks again). nil: present.
  private func ensureDeveloperTools(progress: @Sendable (Step, State) -> Void) -> String? {
    if toolsPresent() { return nil }
    _ = ProcessRunner.run([config.xcodeSelect, "--install"], timeout: 30)
    progress(.developerTools, .waiting(AutoSetup.developerToolsPrompt))
    var sawInstaller = false
    let polls = max(1, Int(config.toolsTimeout / max(config.toolsPollInterval, 0.001)))
    for _ in 0..<polls {
      Thread.sleep(forTimeInterval: config.toolsPollInterval)
      if toolsPresent() { return nil }
      if config.installerRunning() { sawInstaller = true } else if sawInstaller {
        // it was on screen and is gone, with no tools: the owner closed it (or it failed)
        if toolsPresent() { return nil }
        return "Apple's install window was closed before the developer tools were installed, so Talos can't go on yet. Press Try again, and click Install when macOS asks."
      }
    }
    return "Apple's developer tools were not installed after \(Int(config.toolsTimeout / 60)) minutes. If macOS asked, click Install and let it finish, then press Try again."
  }

  public func run(progress: @Sendable (Step, State) -> Void = { _, _ in }) -> Result {
    func fail(_ step: Step, _ message: String) -> Result {
      progress(step, .failed(message))
      return .failed(step: step, message: message)
    }
    var dest = config.destination
    let fm = FileManager.default

    // 0. Apple's developer tools: nothing below runs git or python3 until they are there
    progress(.developerTools, .running)
    if let why = ensureDeveloperTools(progress: progress) { return fail(.developerTools, why) }
    progress(.developerTools, .done)
    let git = config.git ?? config.findGit()

    // 1. which tag, and which commit it names
    progress(.lookup, .running)
    guard let tag = Self.tag(forVersion: config.version) else {
      return fail(
        .lookup,
        "This Talos has no release number (it says \(config.version.map { "\"\($0)\"" } ?? "nothing")), so it can't tell which Talos code to download. "
          + "Install a Talos release, or use Choose… to point at a clone you made yourself.")
    }
    if let why = Self.urlProblem(config.repoURL, allowed: config.allowedSchemes) { return fail(.lookup, why) }
    guard let pinned = config.expectedCommit, Self.isSha(pinned) else {
      return fail(
        .lookup,
        "This build of Talos has no release commit stamped in it (it is a development build), so it won't download code by itself. Use Choose… to point at a clone you made.")
    }
    let want = pinned
    if config.expectedSourceSHA256 == nil {
      // the git route: GitHub's tag must name the stamped commit
      guard let git else {
        return fail(.developerTools, "Apple's developer tools are installed, but Talos can't find git in them. Press Try again; if it keeps failing, restart this Mac and open Talos again.")
      }
      switch lookupWithGit(git, tag: tag) {
      case .failure(let why): return fail(.lookup, why.description)
      case .success(let sha):
        guard sha == pinned else {
          return fail(
            .lookup,
            "The release \(tag) on GitHub names \(sha.prefix(12)), but this Talos was released from \(pinned.prefix(12)), so Talos did not download it. Nothing was changed.")
        }
      }
    } else if let bad = config.expectedSourceSHA256, !Self.isSha256(bad) {
      return fail(.lookup, "The source checksum stamped in this Talos is not a SHA-256 value, so Talos won't download its code by itself. Use Choose… to point at a clone you made.")
    }
    progress(.lookup, .done)

    // 2. the code: reuse a whole one at that commit, else fetch into staging and rename
    progress(.clone, .running)
    let wanted = (dest as NSString).deletingLastPathComponent
    do { try fm.createDirectory(atPath: wanted, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]) } catch {
      return fail(.clone, "Talos couldn't make the folder \(wanted): \(error.localizedDescription). Nothing was changed.")
    }
    // the physical path: the app refuses a recorded clone that has a link in its path
    if let real = realpath(wanted, nil) {
      dest = String(cString: real) + "/" + (dest as NSString).lastPathComponent
      free(real)
    }
    let parent = (dest as NSString).deletingLastPathComponent
    sweepStaleStaging(in: parent)
    if fm.fileExists(atPath: dest) {
      if let why = existingProblem(dest, git: git, want: want, tag: tag) { return fail(.clone, why) }
    } else {
      let staging = parent + "/.talos-clone-" + UUID().uuidString
      func discard() { try? fm.removeItem(atPath: staging) }
      let fresh: String
      let made: String?
      if let sha = config.expectedSourceSHA256 {
        fresh = staging + "/src"
        made = git.map { downloadSource(tag: tag, sha256: sha, commit: want, staging: staging, git: $0) }
          ?? "Apple's developer tools are installed, but Talos can't find git in them. Press Try again."
      } else if let git {
        fresh = staging
        made = cloneWithGit(git, tag: tag, want: want, into: staging)
      } else { fresh = staging; made = "Talos can't find git." }
      if let why = made {
        discard()
        return fail(.clone, why)
      }
      if rename(fresh, dest) != 0 {
        let raced = errno == ENOTEMPTY || errno == EEXIST
        let code = errno
        discard()
        guard raced else { return fail(.clone, "Talos couldn't put the download in place at \(dest) (error \(code)). Nothing was kept.") }
        // another run finished first: its copy is used if it is the right one
        if let why = existingProblem(dest, git: git, want: want, tag: tag) { return fail(.clone, why) }
      } else if fresh != staging {
        discard()  // the archive's staging folder is empty now
      }
    }
    progress(.clone, .done)

    // 3. the copy is whole
    progress(.verify, .running)
    if let why = AgentFolderSetup.cloneProblem(dest) { return fail(.verify, "The download is incomplete: \(why)") }
    progress(.verify, .done)

    // 4. Claude Code, only when it is missing (Anthropic's installer, pinned; no terminal)
    progress(.claude, .running)
    var env = config.env
    if let found = config.claudeFound, !found() {
      guard let inst = config.claudeInstaller else {
        return fail(.claude, "Claude Code is not installed on this Mac, and Talos has no way to install it here. Install it from https://claude.ai/code, then press Retry.")
      }
      if let why = inst.run() { return fail(.claude, why) }
    }
    // Claude Code's installer puts it in ~/.local/bin and leaves the PATH alone; the steps below must find it
    if let p = BundledTools.appending(toPath: env["PATH"], dir: (env["HOME"] ?? NSHomeDirectory()) + "/.local/bin") { env["PATH"] = p }
    progress(.claude, .done)

    // 5. what the clone's own installer needs on this Mac, read-only: its dry run is the one list of prerequisites. With no pnpm
    // the packages come from bun, and the installer is told so (TALOS_JS_RUNTIME) so it asks for neither node nor pnpm.
    progress(.prerequisites, .running)
    env["TALOS_NO_HOOKS"] = "1"  // the clone's git hook installer runs git; on a Mac without the tools that opens Apple's dialog
    if config.pnpm == nil { env["TALOS_JS_RUNTIME"] = "bun" }
    let check = ProcessRunner.run(
      ["/bin/bash", dest + "/install.sh", "--dry-run", "--no-app", "--yes", "--agent-dir", parent + "/preflight-agent"], env: env, cwd: dest,
      timeout: 300)
    switch AgentFolderSetup.createOutcome(status: check.timedOut ? nil : check.status, stderr: check.err) {
    case .done: progress(.prerequisites, .done)
    case .failed(let why), .needsConfirm(let why):
      return fail(.prerequisites, check.timedOut ? "Checking this Mac took too long. Press Retry." : why.replacingOccurrences(of: "Nothing was changed.", with: "Then press Retry. The download is kept."))
    }

    // 6. its JS packages (what install.sh's step 3 runs): pnpm if the Mac has it, else bun (the app's own when nothing else is there)
    progress(.dependencies, .running)
    let installer: [String]
    if let pnpm = config.pnpm {
      installer = [pnpm, "install", "--frozen-lockfile", "--config.confirm-modules-purge=false"]
    } else if let bun = config.bun {
      installer = [bun, "install", "--frozen-lockfile", "--ignore-scripts"]  // same as scripts/install-js.sh
    } else {
      return fail(.dependencies, "Neither pnpm nor bun was found, and Talos's packages need one. Press Retry; if it keeps failing, reinstall Talos.")
    }
    let deps = ProcessRunner.run(installer, env: env, cwd: dest, timeout: config.installTimeout)
    guard deps.ok else {
      let why = deps.timedOut ? "Installing the packages took too long and was stopped." : "Installing the packages failed.\n\(Self.said(deps))"
      return fail(.dependencies, "\(why) The download is kept; press Retry.")
    }
    progress(.dependencies, .done)

    // 7. the record, last: its presence means everything above passed
    progress(.record, .running)
    if let why = writeRecord(dest) { return fail(.record, why) }
    progress(.record, .done)
    return .ok(clone: dest)
  }

  // MARK: pieces

  /// A folder already at the destination: fine when it is a whole copy of this commit (the archive route's marker, or git's HEAD);
  /// otherwise it is the owner's to move.
  private func existingProblem(_ dest: String, git: String?, want: String, tag: String) -> String? {
    var head = (try? String(contentsOfFile: dest + "/" + Self.commitMarker, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
    if head == nil, let git {
      let r = ProcessRunner.run([git, "-C", dest, "rev-parse", "HEAD"], env: gitEnv(), timeout: 30)
      if r.ok { head = r.out.trimmingCharacters(in: .whitespacesAndNewlines) }
    }
    if head == want, AgentFolderSetup.cloneProblem(dest) == nil { return nil }
    return "\(dest) already exists, but it is not a whole copy of \(tag). Talos does not delete folders it did not make: move it aside (for example to \(dest).old), then press Retry."
  }

  // MARK: with git (the Command Line Tools are installed)

  private func lookupWithGit(_ git: String, tag: String) -> Swift.Result<String, LookupFailure> {
    let ls = ProcessRunner.run([git] + gitArgs(["ls-remote", "--tags", "--", config.repoURL]), env: gitEnv(), timeout: config.gitTimeout)
    if ls.timedOut { return .failure(.init("GitHub did not answer in time. Check the network connection, then press Retry. Nothing was changed.")) }
    guard ls.status == 0 else {
      return .failure(.init("Talos couldn't reach \(config.repoURL) to find \(tag). Check the network connection, then press Retry. Nothing was changed.\n\(Self.said(ls))"))
    }
    var sha: String?
    for line in ls.out.split(separator: "\n") {
      let f = line.split(whereSeparator: { $0 == "\t" || $0 == " " }).map(String.init)
      guard f.count == 2 else { continue }
      if f[1] == "refs/tags/\(tag)^{}" { sha = f[0] } else if f[1] == "refs/tags/\(tag)", sha == nil { sha = f[0] }
    }
    guard let want = sha, Self.isSha(want) else { return .failure(.init(Self.noRelease(tag))) }
    return .success(want)
  }

  /// nil: cloned into `staging`, at the commit the tag names.
  private func cloneWithGit(_ git: String, tag: String, want: String, into staging: String) -> String? {
    let cl = ProcessRunner.run(
      [git] + gitArgs(["clone", "--quiet", "--branch", tag, "--single-branch", "--", config.repoURL, staging]), env: gitEnv(),
      timeout: config.gitTimeout)
    guard cl.ok else {
      let why = cl.timedOut ? "The download took too long and was stopped." : "The download failed.\n\(Self.said(cl))"
      return "\(why) Nothing was kept. Check the network connection, then press Retry."
    }
    let head = ProcessRunner.run([git, "-C", staging, "rev-parse", "HEAD"], env: gitEnv(), timeout: 30)
    guard head.ok, head.out.trimmingCharacters(in: .whitespacesAndNewlines) == want else {
      return "The download is not the commit \(tag) names (it changed while Talos was downloading). Nothing was kept. Press Retry."
    }
    return nil
  }

  static func isSha(_ s: String) -> Bool { s.range(of: "^[0-9a-f]{40}$", options: .regularExpression) != nil }
  static func noRelease(_ tag: String) -> String {
    "The Talos repository has no release \(tag), so there is no matching code to download for this version of Talos. Nothing was changed."
  }

  struct LookupFailure: Error, CustomStringConvertible {
    let description: String
    init(_ d: String) { description = d }
  }

  // MARK: the release's own source tarball (the primary route)

  /// nil: `dir` is now a git checkout at `commit` whose files are exactly that commit's tree. (A repository of its own, so `git -C` never
  /// climbs to one above it.)
  private func makeCheckout(at dir: String, commit: String, git: String) -> String? {
    func g(_ args: [String], _ timeout: Double = 120) -> RunResult { ProcessRunner.run([git, "-C", dir] + gitArgs(args), env: gitEnv(), timeout: timeout) }
    let steps: [[String]] = [["init", "--quiet"], ["remote", "add", "origin", config.repoURL]]
    for a in steps {
      let r = g(a)
      if !r.ok { return "Talos couldn't set up the download as a git checkout.\n\(Self.said(r))\nNothing was kept." }
    }
    let f = g(["fetch", "--quiet", "--depth", "1", "origin", commit], config.gitTimeout)
    guard f.ok else { return "Talos couldn't fetch the release's commit to check the download against it.\n\(Self.said(f))\nNothing was kept. Check the network connection, then press Retry." }
    // HEAD and the index to the commit, the files untouched
    let r = g(["reset", "--quiet", commit])
    guard r.ok else { return "Talos couldn't set the download to the release's commit.\n\(Self.said(r))\nNothing was kept." }
    let st = g(["status", "--porcelain", "--ignored"])
    guard st.ok else { return "Talos couldn't compare the download with the release's commit.\n\(Self.said(st))\nNothing was kept." }
    guard st.stdout.isEmpty else {
      let first = st.out.split(separator: "\n").prefix(3).joined(separator: ", ")
      return "The download is not exactly the release's commit (it differs at: \(first)), so Talos did not use it. Nothing was kept."
    }
    return nil
  }

  static func isSha256(_ s: String) -> Bool { s.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil }

  /// nil: `talos-source-<tag>.tar.gz` was downloaded over https (curl and tar by full path, no .curlrc, https only, size and time
  /// capped), its sha256 equals the stamped one BEFORE anything was unpacked, and it is unpacked in `staging/src`, made read-only for
  /// everyone else, and marked with the commit. Else why not (nothing is kept by the caller).
  private func downloadSource(tag: String, sha256: String, commit: String, staging: String, git: String) -> String? {
    let fm = FileManager.default
    let url = config.sourceBase + "/" + tag + "/talos-source-" + tag + ".tar.gz"
    guard let scheme = URLComponents(string: url)?.scheme?.lowercased(), config.allowedSchemes.contains(scheme) else {
      return "The Talos source address (\(url)) is not an https address, so Talos will not use it. Nothing was kept."
    }
    do { try fm.createDirectory(atPath: staging + "/src", withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]) } catch {
      return "Talos couldn't make a folder to unpack into: \(error.localizedDescription). Nothing was kept."
    }
    let file = staging + "/source.tar.gz"
    var args = [config.curl, "-q", "--proto", "=" + scheme, "-fsSL", "--max-time", String(Int(config.gitTimeout)), "--max-filesize", "400000000"]
    if scheme == "https" { args += ["--proto-redir", "=https", "--tlsv1.2"] }
    let dl = ProcessRunner.run(args + ["-o", file, "--", url], env: ClaudeInstaller.minimalEnv(config.env), timeout: config.gitTimeout + 30)
    if dl.timedOut { return "The download took too long and was stopped. Nothing was kept. Check the network connection, then press Retry." }
    guard dl.status == 0 else {
      return "The download of Talos's code failed (\(tag)).\n\(Self.said(dl))\nNothing was kept. Check the network connection, then press Retry."
    }
    let sum = ProcessRunner.run(["/usr/bin/shasum", "-a", "256", file], timeout: 120)
    guard sum.ok, let got = sum.out.split(separator: " ").first.map(String.init), got == sha256 else {
      return "The download is not the one this version of Talos was released with (its checksum differs), so Talos did not unpack it. Nothing was kept. Press Retry; if it keeps failing, reinstall Talos."
    }
    let x = ProcessRunner.run([config.tar, "-xzf", file, "-C", staging + "/src", "--strip-components", "1"], env: ["PATH": "/usr/bin:/bin"], timeout: 300)
    guard x.ok else { return "The download could not be unpacked.\n\(Self.said(x))\nNothing was kept. Press Retry." }
    // nobody but the owner may write what Talos will run
    let m = ProcessRunner.run(["/bin/chmod", "-R", "go-w", staging + "/src"], timeout: 60)
    guard m.ok else { return "Talos couldn't lock the download's permissions.\n\(Self.said(m))\nNothing was kept." }
    try? fm.removeItem(atPath: file)
    // Make it a git checkout of the stamped commit, which the updater needs, and prove the tarball IS that commit's tree: the commit is
    // fetched from the public repository, the index set to it, and the working tree (the unpacked files) must show no difference
    // and no extra file. Any failure and nothing is kept.
    return makeCheckout(at: staging + "/src", commit: commit, git: git)
  }

  /// Staging folders a killed run left behind: ours by name, a day old.
  private func sweepStaleStaging(in parent: String) {
    let fm = FileManager.default
    for name in (try? fm.contentsOfDirectory(atPath: parent)) ?? [] where name.hasPrefix(".talos-clone-") {
      let p = parent + "/" + name
      var st = stat()
      guard lstat(p, &st) == 0, (st.st_mode & S_IFMT) == S_IFDIR, st.st_uid == getuid() else { continue }
      if Date().timeIntervalSince1970 - Double(st.st_mtimespec.tv_sec) > 86_400 { try? fm.removeItem(atPath: p) }
    }
  }

  /// Writes `<clone>\n` to the record file through a temp file and a rename, mode 0600. nil on success.
  private func writeRecord(_ clone: String) -> String? {
    let file = config.recordFile
    let dir = (file as NSString).deletingLastPathComponent
    let tmp = dir + "/.checkout." + UUID().uuidString
    do {
      try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
      guard FileManager.default.createFile(atPath: tmp, contents: Data((clone + "\n").utf8), attributes: [.posixPermissions: 0o600]) else {
        return "Talos couldn't write \(tmp)."
      }
      guard rename(tmp, file) == 0 else {
        try? FileManager.default.removeItem(atPath: tmp)
        return "Talos couldn't record the clone in \(file) (error \(errno)). The download is kept; press Retry."
      }
      return nil
    } catch {
      return "Talos couldn't record the clone in \(file): \(error.localizedDescription). The download is kept; press Retry."
    }
  }
}
