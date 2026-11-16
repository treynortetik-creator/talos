import Foundation

/// What Claude Code has on disk for a session id, and the two session errors of its CLI a start can be mended from. The rules are
/// the Linux supervisor's (apps/bridge/src/supervisor/cli.ts and main.ts), checked there against Claude Code 2.1.322:
///   - a conversation is written to `<config dir>/projects/<folder name>/<id>.jsonl` only after its first message or an `/exit`,
///     so a session nobody has typed in has no file and `--resume <id>` is refused ("No conversation found with session ID");
///   - `--session-id <id>` of an id that has a file in the same folder is refused ("Error: Session ID <id> is already in use"); in
///     another folder it quietly starts a NEW conversation under that id;
///   - a file that holds only meta lines and slash-command markup (an `/exit` before anything was typed) can never be resumed.
public enum SessionTranscript {
  /// The log's name for "no conversation saved, so started with `--session-id` and the same id" (the Linux supervisor's too).
  public static let notSavedEvent = "session_not_saved"
  public static let inUseResumeEvent = "session_in_use_resume"
  public static let emptyNewIdEvent = "session_empty_new_id"

  /// The folder's name under `projects/`: the working directory with every non-alphanumeric as "-". (Claude Code shortens a
  /// name over 200 characters with a hash, which is why `find` also looks in every folder.)
  public static func projectFolderName(_ folder: String) -> String {
    String(folder.map { $0.isASCII && ($0.isLetter || $0.isNumber) ? $0 : "-" })
  }

  public static func path(sessionId: String, folder: String, claudeDir: String) -> String {
    claudeDir + "/projects/" + projectFolderName(folder) + "/" + sessionId + ".jsonl"
  }

  /// The session's file: under the folder's exact name first (as resolved, then as given), then in any folder of `projects/`. The
  /// id is a UUID, so a hit anywhere is this session; after a change of folder a resume then gives the CLI's explicit resume error
  /// instead of a quiet new conversation under the old id. nil when there is none, and for an id that is not a plain UUID (never
  /// made into a path).
  public static func find(sessionId: String, folder: String, claudeDir: String) -> String? {
    guard ResumeRewrite.isUUID(sessionId) else { return nil }
    let fm = FileManager.default
    for f in [physical(folder), folder] {
      let p = path(sessionId: sessionId, folder: f, claudeDir: claudeDir)
      if fm.fileExists(atPath: p) { return p }
    }
    let projects = claudeDir + "/projects"
    for d in ((try? fm.contentsOfDirectory(atPath: projects)) ?? []).sorted() {
      let p = projects + "/" + d + "/" + sessionId + ".jsonl"
      if fm.fileExists(atPath: p) { return p }
    }
    return nil
  }

  /// Saved: a file exists anywhere. An id that is not a UUID is never looked up and counts as saved (it is resumed, as before).
  public static func isSaved(sessionId: String, folder: String, claudeDir: String) -> Bool {
    guard ResumeRewrite.isUUID(sessionId) else { return true }
    return find(sessionId: sessionId, folder: folder, claudeDir: claudeDir) != nil
  }

  /// A file that exists but holds no conversation: no assistant line and no user line of the owner's (meta lines and a slash
  /// command's own markup are not his). A line that does not parse (one being written) is skipped; a file that cannot be read is
  /// not called empty.
  public static func conversationEmpty(sessionId: String, folder: String, claudeDir: String) -> Bool {
    guard let p = find(sessionId: sessionId, folder: folder, claudeDir: claudeDir), let data = FileManager.default.contents(atPath: p)
    else { return false }
    for line in String(decoding: data, as: UTF8.self).split(separator: "\n") {
      guard let rec = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any] else { continue }
      let type = rec["type"] as? String
      if type == "assistant" { return false }
      if type == "user", (rec["isMeta"] as? Bool) != true, !isCommandOnly((rec["message"] as? [String: Any])?["content"]) { return false }
    }
    return true
  }

  /// A user line that is only a slash command's markup: one or more `<command-…>…</command-…>` or `<local-command-…>…</local-command-…>` blocks.
  static func isCommandOnly(_ content: Any?) -> Bool {
    var text = ""
    if let s = content as? String {
      text = s
    } else if let parts = content as? [Any] {
      text = parts.map { ($0 as? [String: Any])?["text"] as? String ?? "" }.joined()
    }
    return text.wholeMatch(of: /\s*(<((?:command|local-command)-[a-z]+)>[\s\S]*?<\/\2>\s*)+/) != nil
  }

  /// The CLI's refusal of `--session-id` on a line of its own.
  public static func sessionInUse(_ rows: [String]) -> Bool {
    rows.map(DialogMatcher.clean).contains { $0.wholeMatch(of: /Error: Session ID \S+ is already in use.*/) != nil }
  }

  /// `realpath`: every link resolved, the last component too (`PathUtil.canonical` leaves a link in the last place as it is).
  private static func physical(_ path: String) -> String {
    guard let r = realpath(path, nil) else { return path }
    defer { free(r) }
    return String(cString: r)
  }
}
