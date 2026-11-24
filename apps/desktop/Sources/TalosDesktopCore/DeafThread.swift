import Foundation

/// The deaf-thread alarm (packages/protocol/src/deaf-thread.ts; the Linux supervisor has the same in `deaf-watch.ts`'s place, see
/// docs/FOLLOWUPS.md). A thread's own session shows something Talos does not recognise (a row under the input box that Claude Code never
/// draws there, no input box, a box not at column 0), so the typing guard (`KeyGuard`) refuses every key; the thread's messages, scheduled
/// runs and card taps then go to Main, and the only sign used to be one quiet line. This is the clock behind a louder one: the pane is
/// read every tick whether or not anything wants to type, so the alarm does not wait for traffic (a thread that only ever gets scheduled
/// runs is as deaf as one that gets messages).
public struct DeafWatch: Equatable, Sendable {
  /// The guard's own reasons that mean "this screen is not Claude's input box": the screen is what is wrong. Not `box_not_empty` (the
  /// owner's draft), not `prompt_on_pane` or a dialog's reasons (a real prompt has its own card and line), not `usage_limit`, not
  /// `unreadable` (a failed read is no evidence of anything).
  public static let deafWhys: Set<String> = ["row_under_box", "no_input_box", "box_not_at_column_0"]

  /// A refusal that counts as deaf, by the guard's code.
  public static func isDeaf(why: String?) -> Bool { why.map(deafWhys.contains) ?? false }

  /// Whether the screen `rows` (plain, no colours) is one Talos would refuse to type into for the screen's own sake. Reads the same guard
  /// that decides a real key, for an empty-box press; sends nothing and writes no log. `escaped` (the same pane with its colours, read only
  /// when the plain one looked deaf): a box at column 0 that holds the owner's draft is the draft hold's to say, not a screen Talos does not know.
  public static func screenIsDeaf(_ rows: [String], escaped: [String]? = nil) -> Bool { why(rows, escaped: escaped) != nil }

  /// The deaf reason for `rows`, or nil: the screen is fine for this purpose (or is not deaf for the screen's own sake).
  public static func why(_ rows: [String], escaped: [String]? = nil) -> String? {
    guard let w = KeyGuard.refusal(rows, intent: .box(.empty))?.why, isDeaf(why: w) else { return nil }
    if w == "row_under_box", let escaped, InputBoxAttributes.draftPresent(escapedRows: escaped) == true { return nil }
    return w
  }

  /// What one read of the screen is worth. `none`: no evidence either way (the owner's text, or Talos's own typed line, sits in the box under
  /// a row Talos does not know, or the guard refused for another reason: a dialog, an unreadable pane). `clear`: a screen the guard would
  /// allow, or a box with text and nothing strange under it (the draft hold's to say, not a screen Talos does not know).
  public enum Look: Equatable, Sendable {
    case clear, none
    case deaf(String)
  }

  public static func look(_ rows: [String], escaped: [String]? = nil) -> Look {
    guard let w = KeyGuard.refusal(rows, intent: .box(.empty))?.why, w != "box_not_empty" else { return .clear }
    guard isDeaf(why: w) else { return .none }
    // text in the box under a strange row: whose it is cannot be said, so it says nothing (neither deaf nor fine)
    if w == "row_under_box", let escaped, InputBoxAttributes.draftPresent(escapedRows: escaped) == true { return .none }
    return .deaf(w)
  }

  public enum Step: Equatable, Sendable {
    /// Past the notice wait: the thread is told, once.
    case notice
    /// Past the Needs-you wait: the phone and the thread list show it.
    case needsYou
    /// Typing works again after the thread was told: when it began (wall clock), for the line that says what Main handled.
    case recovered(sinceWall: Double)
  }

  /// Seconds of OBSERVED refusal before the notice, and before Needs you.
  public var noticeAfter: Double
  public var needsYouAfter: Double
  /// A clear look this long (looks no further apart than `maxGap`) ends a run.
  public var recoverAfter: Double = 10
  /// Looks further apart than this are not one stretch: the time between them was not seen (a sleep, a stalled tick, a turn that hid the pane).
  public var maxGap: Double = 10
  /// Deaf time actually seen, summed only over consecutive looks no further apart than `maxGap`. Two separate glimpses are not one hold.
  public private(set) var observed: Double = 0
  /// When the current run's first refusal was seen (wall clock; for the file, the tally and `needs_you.since`).
  public private(set) var sinceWall: Double?
  public var since: Double? { sinceWall == nil ? nil : observed }
  private var lastLook: Double?
  private var clearSince: Double?
  private var clearSeen = false
  public private(set) var noticed = false
  public private(set) var needsYou = false
  /// Wall-clock times of refused keys (real attempts to press one), the last hour only.
  public private(set) var refusals: [Double] = []

  public init(noticeAfter: Double = 60, needsYouAfter: Double = 600) {
    self.noticeAfter = noticeAfter
    self.needsYouAfter = needsYouAfter
  }

  /// A run found again after a relaunch, from the open notice record (when the thread was told): its time counts as seen. Needs you is
  /// not restored: it takes a deaf look, so a pane that is fine now is never flagged from a record alone.
  public mutating func restore(sinceWall: Double, wall: Double) {
    self.sinceWall = sinceWall
    observed = max(0, wall - sinceWall)
    noticed = true
  }

  /// One look at the pane: `deaf` says the screen is one Talos does not type into (a clear look counts, whatever the pane is doing).
  /// Returns what became due, in order. Deaf time is only what was seen between close looks; a clear look held for `recoverAfter` ends the
  /// run, and so does a clear look followed by a gap in the looks (nobody saw it deaf again).
  public mutating func observe(deaf: Bool, awake: Double, wall: Double) -> [Step] {
    let gap = lastLook.map { awake - $0 } ?? 0
    let apart = gap > maxGap
    lastLook = awake
    var out: [Step] = []
    if sinceWall != nil, apart, clearSeen { out += end() }
    guard deaf else {
      guard sinceWall != nil else { return out }
      clearSeen = true
      let from = (apart ? nil : clearSince) ?? awake
      clearSince = from
      if awake - from >= recoverAfter { out += end() }
      return out
    }
    clearSince = nil
    clearSeen = false
    if sinceWall == nil {
      sinceWall = wall
      observed = 0
    } else if !apart {
      observed += gap
    }
    if !noticed, observed >= noticeAfter {
      noticed = true
      out.append(.notice)
    }
    if !needsYou, observed >= needsYouAfter {
      needsYou = true
      if !noticed {  // told before it is flagged, even when both waits pass in one look
        noticed = true
        out.append(.notice)
      }
      out.append(.needsYou)
    }
    return out
  }

  /// The run is over: what to say about it (only a run that was told about has anything to say).
  public mutating func end() -> [Step] {
    let was = noticed ? [Step.recovered(sinceWall: sinceWall ?? 0)] : []
    sinceWall = nil
    observed = 0
    clearSince = nil
    clearSeen = false
    noticed = false
    needsYou = false
    return was
  }

  /// A key was refused for a deaf reason (an actual attempt: the guard's own log line is the same event).
  public mutating func countRefusal(wall: Double) {
    refusals.append(wall)
    prune(wall: wall)
  }

  /// Refusals in the last hour as of `wall`.
  public func refusalsInLastHour(wall: Double) -> Int { refusals.filter { wall - $0 < 3600 && $0 <= wall + 60 }.count }

  mutating func prune(wall: Double) {
    refusals.removeAll { wall - $0 >= 3600 }
    // bounded: a loop pressing a key every second for an hour is 3,600
    if refusals.count > 5000 { refusals.removeFirst(refusals.count - 5000) }
  }

  /// Whole minutes since the run began, at least 1 once it has begun; nil when it has not.
  public func minutes() -> Int? { sinceWall == nil ? nil : max(1, Int(observed / 60)) }
}

/// What Main handled for a thread while it could not be reached (the bridge's `main-handled.json`: one writer, the bridge).
public struct MainHandledCounts: Equatable, Sendable {
  public var messages = 0
  public var runs = 0
  public var cards = 0
  public init(messages: Int = 0, runs: Int = 0, cards: Int = 0) {
    self.messages = messages
    self.runs = runs
    self.cards = cards
  }
  public var total: Int { messages + runs + cards }

  /// The counts for `thread` from `sinceMs` (epoch ms) on. A file that is missing, too big, damaged or of another version is no count.
  public static func read(_ data: Data?, thread: String, sinceMs: Double) -> MainHandledCounts {
    guard let data, data.count <= 256 * 1024, let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      root["v"] as? Int == 1, let threads = root["threads"] as? [String: Any], let list = threads[thread] as? [[String: Any]]
    else { return MainHandledCounts() }
    var out = MainHandledCounts()
    for e in list {
      guard let at = (e["at"] as? NSNumber)?.doubleValue, at >= sinceMs else { continue }
      switch e["kind"] as? String {
      case "run": out.runs += 1
      case "card": out.cards += 1
      default: out.messages += 1
      }
    }
    return out
  }
}

/// `deaf-threads.json`: which threads cannot be typed into now. The supervisor writes it (one writer), `talos-app doctor`, the Health
/// page and `workers.status` read it. Entries only for threads past the notice wait.
public enum DeafThreadsFile {
  public static let name = "deaf-threads.json"

  /// `threads`: thread id → (when it began in epoch ms, refusals in the last hour).
  public static func encode(at wallMs: Double, threads: [String: (sinceMs: Double, refusals1h: Int)]) -> Data {
    var t: [String: Any] = [:]
    for (id, v) in threads { t[id] = ["since": Int(v.sinceMs), "refusals_1h": v.refusals1h] }
    let root: [String: Any] = ["v": 1, "at": Int(wallMs), "threads": t]
    return (try? JSONSerialization.data(withJSONObject: root, options: [.sortedKeys])) ?? Data()
  }
}

extension WorkerNotice {
  /// The thread's name for a line posted into it: from the owner's config, so it is only ever quoted data (`quoted`), never words of
  /// Talos's own. An empty name reads as the thread's id.
  static func deafName(_ name: String, id: String) -> String { quoted([name]).isEmpty ? quoted([id]) : quoted([name]) }

  /// The one line a thread gets after `DeafWatch.noticeAfter` seconds of refusals. No place to go and no jargon: what is wrong, what
  /// happens to the owner's messages meanwhile.
  public static func deafLine(name: String, id: String) -> String {
    "The \(deafName(name, id: id)) thread has something on its screen Talos doesn't recognise, so Talos can't send it messages right now. If it stays that way, your main agent answers your messages."
  }

  /// The line when typing works again, with what Main answered meanwhile (nothing said of a kind that was zero).
  public static func deafBackLine(name: String, id: String, handled: MainHandledCounts) -> String {
    let who = deafName(name, id: id)
    var parts: [String] = []
    if handled.messages > 0 { parts.append("\(handled.messages) message\(handled.messages == 1 ? "" : "s")") }
    if handled.runs > 0 { parts.append("\(handled.runs) scheduled run\(handled.runs == 1 ? "" : "s")") }
    if handled.cards > 0 { parts.append("\(handled.cards) card tap\(handled.cards == 1 ? "" : "s")") }
    var line = "Talos can message the \(who) thread again."
    guard !parts.isEmpty else { return line }
    let list = parts.count == 1 ? parts[0] : parts.dropLast().joined(separator: ", ") + " and " + parts[parts.count - 1]
    line += " Main handled \(list) while this thread couldn't be reached."
    return line
  }

  /// The record kind of the "can message again" line.
  public static let deafBackKind = "typing back"
}
