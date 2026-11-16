import Foundation

/// A thread session's launch spec on the Mac, for restart on update (the Linux twin is apps/bridge/src/supervisor/launch-spec.ts; the
/// procedure and its vectors are packages/protocol's spec-hash.ts). Built from what a start computes, before it writes anything, so the
/// same function gives the hash of a launch that has not happened (the update check's dry plan) and of one that has
/// (`WorkersFile.Launched.spec_hash`).
///
/// The object: `{v: 1, argv, env, files}`.
/// - argv: the command as launched, without the session flag and its id (`--resume`, `-r`, `--session-id` and their `=` forms). The
///   value of `--append-system-prompt` (the instructions: the thread's own and, outside the agent folder, the folder's instruction
///   files) stands as `PROMPT`; its text is `files["system-prompt.md"]`, as on Linux, with the instruction files' delimiter token
///   replaced by `TOKEN` (`WorkerSpec.promptToken`): the same files are the same spec. Kept as a file so the update check can tell an
///   instruction edit alone from any other change (`Parts.hash(instructionsHash:)`, `WorkersFile.Launched.instructions_hash`).
/// - env: only what the start sets or changes over the login environment it was built on, less `excludedEnv`.
/// - files: each by a stable name, the sha256 hex of its bytes. What the start strips from the environment is hashed as its rule
///   (`env-strip-rules`, `WorkerEnvStripRules.text`), never as the names that happened to be there: a release that strips a new name
///   restarts sessions, a login environment that drifts does not.
public enum LaunchSpecHash {
  /// Never in the spec: the values that differ at every launch. The nonce (its file is never one of `files` either); the session id
  /// rides in argv and is dropped with its flag.
  public static let excludedEnv: Set<String> = ["TALOS_APP_WORKER_NONCE"]
  static let sessionFlags = ["--resume", "-r", "--session-id"]
  /// The spec's name for the strip rule.
  public static let stripRulesEntry = "env-strip-rules"
  /// What stands for the instruction files' delimiter token in a hashed text.
  public static let tokenWord = "TOKEN"
  /// The flag whose value is the session's instructions, what stands for that value in argv, and the spec's name for its text.
  static let promptFlag = "--append-system-prompt"
  public static let promptWord = "PROMPT"
  public static let promptEntry = "system-prompt.md"

  /// argv with the instructions' value taken out (`promptWord` in its place), and that value with the delimiter token replaced; nil
  /// when there is none.
  public static func argvWithoutPrompt(_ argv: [String], token: String?) -> (argv: [String], prompt: String?) {
    var out: [String] = []
    var prompt: String?
    var i = 0
    while i < argv.count {
      let a = argv[i]
      if a == promptFlag, i + 1 < argv.count {
        prompt = argv[i + 1]
        out += [a, promptWord]
        i += 2
        continue
      }
      if a.hasPrefix(promptFlag + "=") {
        prompt = String(a.dropFirst(promptFlag.count + 1))
        out.append(promptFlag + "=" + promptWord)
        i += 1
        continue
      }
      out.append(a)
      i += 1
    }
    let replaced = prompt.map { p in token.map { !$0.isEmpty ? p.replacingOccurrences(of: $0, with: tokenWord) : p } ?? p }
    return (out, replaced)
  }

  /// A launch's spec, kept whole so its hash can also be made with another instruction digest in place of its own.
  public struct Parts: Sendable, Equatable {
    public var argv: [String]
    public var env: [String: String]
    public var baseEnv: [String: String]
    public var files: [String: Data?]
    public var token: String?
    public init(argv: [String], env: [String: String], baseEnv: [String: String], files: [String: Data?], token: String? = nil) {
      self.argv = argv
      self.env = env
      self.baseEnv = baseEnv
      self.files = files
      self.token = token
    }

    /// `spec_hash` of this launch; nil when it cannot be made.
    public var hash: String? { LaunchSpecHash.hash(argv: argv, env: env, baseEnv: baseEnv, files: files, token: token) }

    /// `instructions_hash`: "sha256:" + hex of the instructions the start hands the session (the `--append-system-prompt` value, the
    /// delimiter token replaced); nil when it is given none.
    public var instructionsHash: String? {
      LaunchSpecHash.argvWithoutPrompt(argv, token: token).prompt.map { "sha256:" + SpecHash.hex(Data($0.utf8)) }
    }

    /// The hash this same launch would have with the instructions whose digest is `instructionsHash` (a recorded one) in place of its
    /// own: equal to a recorded `spec_hash` only when nothing but the instructions changed since. nil for a digest that is not one.
    public func hash(instructionsHash other: String) -> String? {
      guard SpecHash.isValid(other) else { return nil }
      let hex = String(other.dropFirst("sha256:".count))
      return try? SpecHash.hash(LaunchSpecHash.spec(argv: argv, env: env, baseEnv: baseEnv, files: files, token: token, promptHex: hex))
    }
  }

  /// argv without the session flag and its value (both forms); everything else in order.
  public static func argvWithoutSession(_ argv: [String]) -> [String] {
    var out: [String] = []
    var i = 0
    while i < argv.count {
      let a = argv[i]
      if sessionFlags.contains(a) {
        i += 2
        continue
      }
      if sessionFlags.contains(where: { $0.hasPrefix("--") && a.hasPrefix($0 + "=") }) {
        i += 1
        continue
      }
      out.append(a)
      i += 1
    }
    return out
  }

  /// The procedure's object. `files`: name → the exact bytes the start writes (nil: not written, left out). `token`: the instruction
  /// files' delimiter token of this start, replaced in argv. `stripRules`: a test's rule; none = this build's.
  /// `promptHex`: the instructions' digest to hash in place of this launch's own (`Parts.hash(instructionsHash:)`).
  public static func spec(
    argv: [String], env: [String: String], baseEnv: [String: String], files: [String: Data?], token: String? = nil,
    stripRules: String? = nil, promptHex: String? = nil
  ) -> SpecJSON {
    let split = argvWithoutPrompt(argvWithoutSession(argv), token: token)
    let args = split.argv.map { a in token.map { !$0.isEmpty ? a.replacingOccurrences(of: $0, with: tokenWord) : a } ?? a }
    var set: [String: String] = [:]
    for (k, v) in env where baseEnv[k] != v && !excludedEnv.contains(k) { set[k] = v }
    var hashed: [String: String] = [:]
    for (name, bytes) in files { if let bytes { hashed[name] = SpecHash.hex(bytes) } }
    if let p = split.prompt { hashed[promptEntry] = promptHex ?? SpecHash.hex(Data(p.utf8)) }
    hashed[stripRulesEntry] = SpecHash.hex(Data((stripRules ?? WorkerEnvStripRules.text).utf8))
    return .object([
      .init("v", .number(1)), .init("argv", .array(args.map(SpecJSON.str))), .init("env", .strings(set)), .init("files", .strings(hashed)),
    ])
  }

  /// `spec_hash` for this launch, or nil when it cannot be made: the session then reads as one an older build started, and a hash
  /// never refuses a start.
  public static func hash(
    argv: [String], env: [String: String], baseEnv: [String: String], files: [String: Data?], token: String? = nil
  ) -> String? {
    try? SpecHash.hash(spec(argv: argv, env: env, baseEnv: baseEnv, files: files, token: token))
  }
}

/// The Mac's rule for what a thread session's environment loses, as one canonical text: every list the stripping code reads, by the
/// constants that code reads (`ClaudeEnvScrub`, `LoginShellEnv`, `WorkerSpec`), so the text cannot say one thing while the code does
/// another. The launch spec hashes it as `files["env-strip-rules"]`.
public enum WorkerEnvStripRules {
  static func list(_ s: Set<String>) -> SpecJSON { .array(s.sorted().map(SpecJSON.str)) }
  static func list(_ a: [String]) -> SpecJSON { .array(a.sorted().map(SpecJSON.str)) }

  public static var object: SpecJSON {
    .object([
      // ClaudeEnvScrub: what a Claude Code session leaves in its children's environment
      .init(
        "claude_markers",
        .object([
          .init("always_drop", list(ClaudeEnvScrub.alwaysDrop)), .init("session_markers", list(ClaudeEnvScrub.sessionMarkers)),
          .init("prefix", .str("CLAUDE_CODE_")), .init("keep", list(ClaudeEnvScrub.keep)), .init("keep_prefixes", list(ClaudeEnvScrub.keepPrefixes)),
        ])),
      .init("shell_startup", list(ClaudeEnvScrub.shellStartup)), .init("shell_startup_prefixes", list(ClaudeEnvScrub.shellStartupPrefixes)),
      // LoginShellEnv.build: the terminal's own, and a thread session's switches leaked into the app's environment
      .init(
        "login_env",
        .object([
          .init("terminal_only", list(LoginShellEnv.denylist)), .init("channel_switch_always", list(LoginShellEnv.workerSwitchAlways)),
          .init("channel_switch_nochannel", list(LoginShellEnv.workerSwitchNoChannel)), .init("nochannel_suffix", .str(LoginShellEnv.noChannelSuffix)),
        ])),
      // WorkerSpec.build: never in a thread session's environment
      .init("names", list(WorkerSpec.strippedEnv)), .init("prefixes", list(WorkerSpec.strippedPrefixes)),
    ])
  }

  /// The rule as the spec hashes it.
  public static var text: String { (try? JCS.text(object)) ?? "" }
}
