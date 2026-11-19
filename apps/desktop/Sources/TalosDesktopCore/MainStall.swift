import Foundation

/// What Main's pane shows of a model request in flight, for the stall alarm (`MainWatch.observeStall`). Claude Code redraws its working
/// line every second (`✻ Pondering… (19s · still thinking)`: its elapsed counter), so "the pane printed" says nothing about a request that
/// has stopped answering. The body with that counter masked moves only when something real does: a token count, the verb, the label, a
/// new line of the conversation.
public enum MainStall {
  /// The working line: a spinner glyph, a verb ending in "…", then optionally the parenthesised counter or hint. Not the answer's own
  /// row (`⏺`) nor the owner's (`❯`); "Cooked for 9s" (a finished turn) has no "…".
  static let workingLine = try! NSRegularExpression(
    pattern: #"^[ \t]*[^\sA-Za-z0-9(⏺❯][ \t]+[A-Za-z][A-Za-z' -]*…(?:[ \t]*\(.*\))?[ \t]*$"#)
  /// The elapsed part: `(19s`, `(1m 5s`, `(1h 2m 3s`.
  static let elapsed = try! NSRegularExpression(pattern: #"\(\d+[hms](?: \d+[hms])*"#)

  private static func isWorking(_ line: String) -> Bool {
    workingLine.firstMatch(in: line, range: NSRange(location: 0, length: (line as NSString).length)) != nil
  }

  public static func hasWorkingLine(rows: [String]) -> Bool { WorkerActivity.body(rows: rows).split(separator: "\n", omittingEmptySubsequences: false).contains { isWorking(String($0)) } }

  /// Main is idle at its prompt: Claude's input box live and empty, no working line, no select, prompt or dialog anywhere (the screen the
  /// `.interruptBlank` gate reads, asked here as a plain question: this presses nothing). `escapedRows` are the rows with their colours.
  public static func idlePrompt(escapedRows: [String]?) -> Bool { KeyGuard.refusal(escapedRows, intent: .interruptBlank) == nil }

  /// `WorkerActivity.body` with each working line's elapsed counter (`(5s`, `(1m 5s`) read as "(#" (the token count, verb and label kept).
  public static func maskedBody(rows: [String]) -> String {
    WorkerActivity.body(rows: rows).split(separator: "\n", omittingEmptySubsequences: false).map { sub -> String in
      let line = String(sub)
      guard isWorking(line) else { return line }
      let ns = line as NSString
      var out = line
      for m in elapsed.matches(in: line, range: NSRange(location: 0, length: ns.length)).reversed() {
        out = (out as NSString).replacingCharacters(in: m.range, with: "(#")  // "(5s" and "(1m 5s" read alike
      }
      return out
    }.joined(separator: "\n")
  }

  /// Whether the working line's label says the model is thinking ("thinking", "still thinking"): a longer wait applies.
  public static func isThinking(rows: [String]) -> Bool {
    WorkerActivity.body(rows: rows).split(separator: "\n", omittingEmptySubsequences: false)
      .contains { isWorking(String($0)) && $0.contains("thinking") }
  }

  // MARK: Main's transcript

  /// The newest records of Main's transcript, as far as the stall alarm needs them.
  public struct Transcript: Equatable, Sendable {
    public enum Tail: Equatable, Sendable {
      /// The newest user or assistant record is a user turn (the delivered channel message, or a tool_result) and the model has not
      /// answered it: a request in flight. `since` is that record's time when it has one.
      case awaitingModel(since: Date?)
      /// The newest is the model's: a reply, or a tool_use whose result has not come back (Main runs a tool or a sub-agent).
      case answered
      /// The newest is the model's, but only thinking blocks so far: the turn is still in progress (a request that hangs after
      /// thinking looks exactly like this). `since` is that record's time.
      case thinking(since: Date?)
      /// Nothing in the tail read as a turn.
      case unknown
    }
    public var size: Int64
    public var tail: Tail
    public init(size: Int64, tail: Tail) {
      self.size = size
      self.tail = tail
    }
  }

  /// How much of the end of the file is read: a transcript runs to many megabytes.
  static let tailBytes = 64 * 1024

  /// The file's size and what its last 64 KiB say; nil when it cannot be opened or read (that signal is unknown).
  public static func transcript(atPath path: String) -> Transcript? {
    guard let h = FileHandle(forReadingAtPath: path) else { return nil }
    defer { try? h.close() }
    do {
      let size = try h.seekToEnd()
      let from = size > UInt64(tailBytes) ? size - UInt64(tailBytes) : 0
      try h.seek(toOffset: from)
      let data = try h.readToEnd() ?? Data()
      return Transcript(size: Int64(size), tail: tail(of: data, startsMidFile: from > 0))
    } catch { return nil }
  }

  /// The newest user or assistant record of `data` (the end of a transcript, JSON lines). A line that does not parse (one being
  /// written, or the fragment a mid-file read begins with) is skipped; a sub-agent's records (`isSidechain`) are not Main's turn.
  public static func tail(of data: Data, startsMidFile: Bool) -> Transcript.Tail {
    var lines = data.split(separator: UInt8(ascii: "\n"), omittingEmptySubsequences: true)
    if startsMidFile, !lines.isEmpty { lines.removeFirst() }
    for line in lines.reversed() {
      guard let rec = (try? JSONSerialization.jsonObject(with: Data(line))) as? [String: Any], rec["isSidechain"] as? Bool != true
      else { continue }
      // Claude Code's own record of a request it gave up on ("API Error: Request timed out") is a failed turn, not an answer
      if rec["isApiErrorMessage"] as? Bool == true || (rec["message"] as? [String: Any])?["model"] as? String == "<synthetic>" { continue }
      switch rec["type"] as? String {
      case "assistant":
        let blocks = ((rec["message"] as? [String: Any])?["content"] as? [Any])?.map { ($0 as? [String: Any])?["type"] as? String }
        // only thinking blocks (at least one): no text and no tool_use yet, so nothing has been answered
        if let blocks, !blocks.isEmpty, blocks.allSatisfy({ $0 == "thinking" || $0 == "redacted_thinking" }) {
          return .thinking(since: (rec["timestamp"] as? String).flatMap(parseTime))
        }
        return .answered
      case "user":
        // Records Claude Code writes that are not a delivered message: its own meta caveats, and the local slash commands' wrappers
        // (`/model`, `/status`: `<command-name>…`, `<local-command-stdout>…`). They say nothing about the model's turn, so the record
        // before them stands. The owner's own interrupt ("[Request interrupted by user]", also "… for tool use]") ENDS the turn: nothing
        // is pending and nothing is stuck. Only those record shapes and marker strings are read, never the rest of the content.
        if rec["isMeta"] as? Bool == true { continue }
        let content = (rec["message"] as? [String: Any])?["content"]
        if let text = content as? String, localCommandPrefixes.contains(where: { text.hasPrefix($0) }) { continue }
        if isInterrupt(content) { return .answered }
        return .awaitingModel(since: (rec["timestamp"] as? String).flatMap(parseTime))
      default: continue
      }
    }
    return .unknown
  }

  /// Wrappers of a local slash command's records (`/model`, `/status`, `/compact`): the command line, its output, and its caveat.
  static let localCommandPrefixes = ["<command-name>", "<command-message>", "<local-command-stdout>", "<local-command-stderr>", "<local-command-caveat>"]
  static let interruptMarker = "[Request interrupted by user"

  /// A user record that is Claude Code's note of the owner's own interrupt: a text block, or a tool_result's text, that starts with the marker.
  static func isInterrupt(_ content: Any?) -> Bool {
    func marked(_ v: Any?) -> Bool {
      if let t = v as? String { return t.hasPrefix(interruptMarker) }
      if let blocks = v as? [Any] {
        return blocks.contains { b in
          guard let b = b as? [String: Any] else { return false }
          return marked(b["text"]) || marked(b["content"])
        }
      }
      return false
    }
    return marked(content)
  }

  private static func parseTime(_ s: String) -> Date? {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = f.date(from: s) { return d }
    f.formatOptions = [.withInternetDateTime]
    return f.date(from: s)
  }
}
