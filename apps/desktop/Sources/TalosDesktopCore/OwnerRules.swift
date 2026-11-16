import Foundation

/// The owner's own rules for the agent, written as a file of their own in the agent folder's `.claude/rules/`, which Claude Code
/// reads at the start of a session (the kit's `talos-defaults.md` sits beside it and is the only one an update replaces, so an
/// update never touches this one: standing rule 1). Shipped default: no file. Talos writes the file only for text the owner
/// typed, and only removes a file it wrote.
public enum OwnerRules {
  public static let fileName = "owner-rules.md"
  public static let maxLength = 4000
  /// First line of the file Talos writes. A file without it was not written by Talos and is never replaced or removed.
  public static let header = "<!-- Written by Talos (Set up > Rules for your agent). Edit it there; this line marks it as yours to change in Talos. -->"

  public static func path(agentDir: String) -> String { agentDir + "/.claude/rules/" + fileName }

  public enum Result: Equatable, Sendable {
    case saved
    case removed
    case nothingToSave
    case refused(String)
  }

  /// The text as it will be saved: line and paragraph separators (U+2028/2029) become newlines; control, direction, zero-width and
  /// Unicode tag characters other than newline and tab are dropped (they can hide what a line says); lines are trimmed at the
  /// end and the whole is trimmed.
  public static func clean(_ text: String) -> String {
    let hidden: Set<UInt32> = [0x061C, 0x200E, 0x200F, 0x2060, 0xFEFF]
    var out = String.UnicodeScalarView()
    for u in text.unicodeScalars {
      let v = u.value
      if v == 0x2028 || v == 0x2029 { out.append("\n"); continue }
      let drop =
        (v < 0x20 && v != 0x0A && v != 0x09) || v == 0x7F || (0x80...0x9F).contains(v) || (0x200B...0x200D).contains(v)
        || (0x202A...0x202E).contains(v) || (0x2066...0x2069).contains(v) || (0xE0000...0xE007F).contains(v) || hidden.contains(v)
      if !drop { out.append(u) }
    }
    let lines = String(out).split(separator: "\n", omittingEmptySubsequences: false)
      .map { $0.replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression) }
    return lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
  }

  /// What the box shows for the folder: the saved text without the header, "" when there is no file or it is not Talos's.
  public static func load(agentDir: String) -> String {
    guard let d = FileManager.default.contents(atPath: path(agentDir: agentDir)) else { return "" }
    let s = String(decoding: d, as: UTF8.self)
    guard s.hasPrefix(header) else { return "" }
    return s.dropFirst(header.count).trimmingCharacters(in: .whitespacesAndNewlines)
  }

  /// Saves `text`. Empty text removes the file Talos wrote earlier (and does nothing when there is none). Refuses a folder that is
  /// not there, a `.claude` or `rules` that is a link, text that is too long, and a file of that name Talos did not write.
  public static func save(_ text: String, agentDir: String) -> Result {
    let fm = FileManager.default
    var isDir: ObjCBool = false
    guard agentDir.hasPrefix("/"), fm.fileExists(atPath: agentDir, isDirectory: &isDir), isDir.boolValue else {
      return .refused(OnboardingText.rulesNoFolder(agentDir))
    }
    let cleaned = clean(text)
    if cleaned.count > maxLength { return .refused(OnboardingText.rulesTooLong(cleaned.count, max: maxLength)) }
    let claudeDir = agentDir + "/.claude"
    let rulesDir = claudeDir + "/rules"
    let file = path(agentDir: agentDir)
    for p in [claudeDir, rulesDir, file] where (try? fm.destinationOfSymbolicLink(atPath: p)) != nil {
      return .refused(OnboardingText.rulesLink(p))
    }
    let existing = fm.contents(atPath: file).map { String(decoding: $0, as: UTF8.self) }
    if let existing, !existing.hasPrefix(header) {
      return .refused(OnboardingText.rulesForeignFile(file))
    }
    if cleaned.isEmpty {
      guard existing != nil else { return .nothingToSave }
      do { try fm.removeItem(atPath: file) } catch { return .refused(OnboardingText.rulesCannotRemove(file)) }
      return .removed
    }
    do {
      try fm.createDirectory(atPath: rulesDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o755])
      try AtomicFile.write(Data((header + "\n\n" + cleaned + "\n").utf8), to: file, mode: 0o644)
    } catch {
      return .refused(OnboardingText.rulesCannotWrite(file))
    }
    return .saved
  }
}
