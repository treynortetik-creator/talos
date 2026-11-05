import Foundation

/// Editing the launch command in place (Mac settings → Session). It changes only the program and its arguments, through the
/// same parser as Import (`LaunchSpec.parse`). Everything else the file holds about the launch stays as it is: the folder (its
/// own field), the environment (values are never shown and never touched here) and the conversation ids.
public enum LaunchEdit {
  public enum Outcome: Equatable, Sendable {
    /// Nothing differs from what is saved.
    case unchanged
    /// Save this. The next start is a cold one.
    case updated(claudePath: String, args: [String])
    /// Keep the old value and show this reason.
    case refused(String)
  }

  public static let envPointer =
    "That line sets environment variables. Edit those through Import (paste the whole command): their values are never shown or changed here."
  public static let folderPointer = "The folder has its own box above. Leave `cd …` out of this line."
  public static let resumePointer = "Talos keeps the conversation itself. Leave `--resume`, `--session-id`, `--continue` (`-c`) and `--fork-session` out of this line."
  public static let coldNote =
    "Saved. The next start of the agent is a cold start: you confirm the development-channel dialog once in the terminal pane. Nothing restarts on its own."

  /// What the box shows: the program and its arguments, shell-quoted. No `cd`, no environment, no conversation id.
  public static func line(for cfg: DesktopConfig) -> String {
    let program = cfg.claudePath == "auto" ? "claude" : cfg.claudePath
    return ([LaunchSpec.shellQuote(program)] + ResumeRewrite.strip(cfg.args).map(LaunchSpec.shellQuote)).joined(separator: " ")
  }

  /// The names (never the values) of the environment variables the launch carries, sorted.
  public static func envNames(_ cfg: DesktopConfig) -> [String] { cfg.env.keys.sorted() }

  /// One sentence about the environment, names only.
  public static func envLine(_ cfg: DesktopConfig) -> String {
    let n = envNames(cfg)
    if n.isEmpty { return "No environment variables are set for the agent." }
    return "Environment variables kept (values hidden): \(n.joined(separator: ", ")). Change them with Import."
  }

  /// Whether the box should pick up the config's line: only when nothing is being typed and the line really changed (Import or
  /// Adopt rewrote it). The box's own save changes the config too; its line then already matches and the "Saved" note stays.
  public static func shouldReload(draft: String, loaded: String, current: String) -> Bool {
    draft == loaded && current != loaded
  }

  public static func evaluate(_ text: String, against cfg: DesktopConfig, home: String) -> Outcome {
    let spec: LaunchSpec
    do {
      spec = try LaunchSpec.parse(text, home: home)
    } catch let e as LaunchSpec.ParseError {
      return .refused(e.description)
    } catch {
      return .refused("\(error)")
    }
    // Everything that doesn't belong in this box is named at once (a pasted Terminal command carries all three).
    var no: [String] = []
    if spec.agentDir != nil { no.append(folderPointer) }
    if !spec.env.isEmpty { no.append(envPointer) }
    // `parse` strips `--continue`, `-c` and `--fork-session` without a trace (Import wants that); here a flag that vanishes would
    // read as a save that did nothing, so name it.
    let dropsConversationFlag = ((try? LaunchSpec.tokenize(text.trimmingCharacters(in: .whitespaces), home: home)) ?? []).contains {
      if case .word(let w) = $0 { return ResumeRewrite.bare.contains(w) }
      return false
    }
    if spec.resumeId != nil || dropsConversationFlag { no.append(resumePointer) }
    if !no.isEmpty { return .refused(no.joined(separator: " ")) }
    let path = spec.program == "claude" ? "auto" : spec.program
    if path == cfg.claudePath && spec.args == ResumeRewrite.strip(cfg.args) { return .unchanged }
    return .updated(claudePath: path, args: spec.args)
  }

  /// The config after an accepted edit: only `claude_path` and `args` differ. Environment and conversation ids are copied
  /// through untouched.
  public static func applied(_ cfg: DesktopConfig, claudePath: String, args: [String]) -> DesktopConfig {
    var c = cfg
    c.claudePath = claudePath
    c.args = args
    return c
  }
}
