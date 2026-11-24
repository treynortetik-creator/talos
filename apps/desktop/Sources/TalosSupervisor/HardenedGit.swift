import Foundation

/// How Talos runs git in a folder an agent can write to (the Talos code folder, or a download being checked). The folder's own
/// `.git/config`, hooks, attributes and fsmonitor can all make git run a program, so nothing of its own steers a call:
///   - no fsmonitor program, no hooks, no commit graph, and the repository named outright (`--git-dir`, `--work-tree`), so git never
///     searches upward for another one;
///   - an environment built from nothing, not copied and then trimmed: no GIT_* variable, no user or system git config, no prompt, no
///     object replacement;
///   - git by its full path.
/// A fetch goes to an explicit address (never the folder's own `origin`), over a protocol list of its own, with no credential helper,
/// askpass program or ssh command. `auto-update-apply.sh --preflight` is the other half: it refuses a folder whose own files would
/// still steer git, and runs before the first call here.
enum HardenedGit {
  /// The settings that go before the command, in this order.
  /// (core.alternateRefsCommand runs a program when a repository has alternates; maintenance and gc must never start a background
  /// job in the folder.) The empty values are real settings: an empty command does nothing.
  static let hardening = [
    "-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null", "-c", "core.commitGraph=false", "-c", "core.alternateRefsCommand=",
    "-c", "maintenance.auto=false", "-c", "gc.auto=0",
  ]
  /// The settings a fetch adds: only `schemes` may be used, and no helper may supply a password or run ssh.
  static func fetchSettings(schemes: [String]) -> [String] {
    var a = ["-c", "protocol.allow=never"]
    for s in schemes { a += ["-c", "protocol.\(s).allow=always"] }
    return a + ["-c", "credential.helper=", "-c", "core.askPass=", "-c", "core.sshCommand="]
  }
  static let proxyKeys = [
    "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR",
  ]

  /// `git <hardening> --git-dir=<co>/.git --work-tree=<co> <args>`.
  static func argv(git: String, checkout: String, args: [String]) -> [String] {
    [git] + hardening + ["--git-dir=" + checkout + "/.git", "--work-tree=" + checkout] + args
  }

  /// A fetch of `refspecs` from `url`: `options` (flags such as --quiet) come before the address.
  static func fetchArgv(git: String, checkout: String, url: String, schemes: [String], options: [String], refspecs: [String]) -> [String] {
    [git] + hardening + fetchSettings(schemes: schemes) + ["--git-dir=" + checkout + "/.git", "--work-tree=" + checkout]
      + ["fetch"] + options + ["--", url] + refspecs
  }

  /// The environment git runs in, built from `base` (the owner's login environment): a fixed system PATH (git is run by full path), HOME, the locale, the temp folder and any
  /// proxy settings, and nothing else of it.
  static func env(from base: [String: String]) -> [String: String] {
    var e: [String: String] = [
      "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": base["HOME"] ?? NSHomeDirectory(),
      "LC_ALL": base["LC_ALL"] ?? "C", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_TERMINAL_PROMPT": "0",
      "GIT_NO_REPLACE_OBJECTS": "1", "GIT_ALTERNATE_OBJECT_DIRECTORIES": "",
    ]
    for k in ["LANG", "TMPDIR"] + proxyKeys { if let v = base[k] { e[k] = v } }
    return e
  }

  /// The environment the apply script runs in (`--preflight`, `--prepare`, `--restore`). The script finds env, mktemp and grep through
  /// PATH, and /opt/homebrew/bin and ~/.local/bin are writable by the owner's own programs, so PATH here is the system folders, then
  /// git's own folder, and nothing of the login PATH unless `deps`: --prepare and --restore install packages, and pnpm or bun are
  /// found only after every system folder (a program put in a user folder never stands in for env, git, mktemp or grep). HOME, the
  /// locale, TMPDIR and, for `deps`, the proxies come from `base`.
  static func scriptEnv(from base: [String: String], git: String, deps: Bool) -> [String: String] {
    let system = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]
    var path = system
    let gitDir = (git as NSString).deletingLastPathComponent
    if !path.contains(gitDir) { path.append(gitDir) }
    if deps {
      for d in (base["PATH"] ?? "").split(separator: ":").map(String.init) where d.hasPrefix("/") && !path.contains(d) { path.append(d) }
    }
    var e: [String: String] = ["PATH": path.joined(separator: ":"), "HOME": base["HOME"] ?? NSHomeDirectory()]
    var keep = ["LANG", "LC_ALL", "TMPDIR"]
    if deps { keep += proxyKeys + ["http_proxy", "HTTP_PROXY", "TALOS_JS_RUNTIME", "TALOS_NO_HOOKS"] }
    for k in keep { if let v = base[k] { e[k] = v } }
    return e
  }

  /// The git to run, by full path. /usr/bin/git when the Command Line Tools are installed (`xcode-select -p` succeeds; without them it
  /// is a stub that opens an install dialog), else /opt/homebrew/bin/git (then /usr/local/bin/git). Never found through PATH.
  static func resolve() -> String? {
    CloneProvisioner.findGit(cltInstalled: CloneProvisioner.commandLineToolsInstalled(), isExecutable: FileManager.default.isExecutableFile)
  }

  /// The protocols a fetch from `url` may use: https; a local path or file:// only when `allowLocal` (tests). Empty: do not fetch.
  static func schemes(for url: String, allowLocal: Bool) -> [String] {
    if let c = URLComponents(string: url), c.scheme?.lowercased() == "https", (c.host ?? "").isEmpty == false, c.user == nil, c.password == nil {
      return ["https"]
    }
    if allowLocal, url.hasPrefix("/") || url.hasPrefix("file://") { return ["file"] }
    return []
  }
}
