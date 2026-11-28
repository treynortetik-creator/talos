import Foundation

/// A turn that was cut (Wave 0, 0.26): a thread session that was in the middle of a turn when it died, by a crash or by a restart the stop
/// limit forced, is started again with Claude Code asked to resume that turn. The rules, all pure here; the manager (WorkerCutTurn.swift)
/// decides when to ask and does the reading and the killing. The record lives in `workers/<thread>/cut-turn.json`.
///
/// Recorded: a death with a turn in progress (`turn_started_at` on file), by a crash (`why: crash`) or by the stop limit giving up on
/// a turn that a Restart was waiting for (`stop_limit_restart`). Not recorded: an owner's stop (a park, which is no death mid-turn that
/// anyone wants undone), a turn the owner stopped with Esc, a session in plan mode, a death with no turn in progress.
/// Used: only at the next start of the same conversation by `--resume`, within `window` of the cut, and never twice in a row: a re-run
/// that is cut again is not run again (`from_rerun`), however often the app restarts meanwhile (the marker is on disk).
public struct CutTurnFile: Codable, Equatable, Sendable {
  public var pending: CutTurn.Cut?
  public var rerun: CutTurn.Rerun?
  public init(pending: CutTurn.Cut? = nil, rerun: CutTurn.Rerun? = nil) {
    self.pending = pending
    self.rerun = rerun
  }

  /// Each field reads on its own: one that is not what this build writes reads as absent, never the whole file as unreadable.
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    pending = (try? c.decodeIfPresent(CutTurn.Cut.self, forKey: .pending)) ?? nil
    rerun = (try? c.decodeIfPresent(CutTurn.Rerun.self, forKey: .rerun)) ?? nil
  }
  enum Keys: String, CodingKey { case pending, rerun }
}

public enum CutTurn {
  /// How long after the cut a start may still resume the turn.
  public static let window: Double = 1800
  /// How far ahead of now a cut may be before the clock is thought to have moved (a second or two of skew is not a jump).
  static let skew: Double = 60
  /// What a re-run start sets, and only that: the exact two names (they are left out of the launch hash, `LaunchSpecHash.excludedEnv`).
  public static let resumeEnv: [String: String] = [
    "CLAUDE_CODE_RESUME_INTERRUPTED_TURN": "1", "CLAUDE_CODE_RESUME_REASON": "user_resume",
  ]

  public struct Cut: Codable, Equatable, Sendable {
    public var session_id: String
    /// ISO times: when the cut turn began (nil when the turn was not typed by Talos and its start is unknown, so nothing is reaped),
    /// and when it was cut.
    public var turn_started_at: String?
    public var cut_at: String
    /// The dead launch's TALOS_APP_WORKER_NONCE: what its leftover processes are found by. nil: unknown, nothing is reaped.
    public var nonce: String?
    /// `crash` or `stop_limit_restart`; a value from a newer build is kept as it is.
    public var why: String
    /// The cut turn was itself a re-run: it is not run again.
    public var from_rerun: Bool

    public init(session_id: String, turn_started_at: String?, cut_at: String, nonce: String?, why: String, from_rerun: Bool) {
      self.session_id = session_id
      self.turn_started_at = turn_started_at
      self.cut_at = cut_at
      self.nonce = nonce
      self.why = why
      self.from_rerun = from_rerun
    }

    public init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: Keys.self)
      session_id = try c.decode(String.self, forKey: .session_id)
      turn_started_at = (try? c.decodeIfPresent(String.self, forKey: .turn_started_at)) ?? nil
      cut_at = try c.decode(String.self, forKey: .cut_at)
      nonce = (try? c.decodeIfPresent(String.self, forKey: .nonce)) ?? nil
      why = try c.decode(String.self, forKey: .why)
      from_rerun = (try? c.decodeIfPresent(Bool.self, forKey: .from_rerun)) ?? false
    }
    enum Keys: String, CodingKey { case session_id, turn_started_at, cut_at, nonce, why, from_rerun }
  }

  /// The launch now running because of a re-run: until its resumed turn ends, a cut of it is a cut of a re-run.
  public struct Rerun: Codable, Equatable, Sendable {
    public var session_id: String
    public var nonce: String
    public init(session_id: String, nonce: String) {
      self.session_id = session_id
      self.nonce = nonce
    }
  }

  public enum Why: String, Sendable { case crash, stopLimitRestart = "stop_limit_restart" }

  /// What the manager knew when the session died.
  public struct Death: Sendable {
    public var sessionId: String?
    /// A turn was in progress: Talos typed it (`turn_started_at`) or the pane was busy (the owner typed in the Terminals window).
    public var midTurn: Bool
    /// When it began, when Talos typed it; nil: not known.
    public var turnStartedAt: Double?
    public var cutAt: Double
    /// The dead launch's nonce, from its file.
    public var nonce: String?
    public var why: Why
    /// The session's screen showed plan mode, or an Esc stop.
    public var planMode: Bool
    public var escaped: Bool
    public init(
      sessionId: String?, midTurn: Bool, turnStartedAt: Double?, cutAt: Double, nonce: String?, why: Why, planMode: Bool, escaped: Bool
    ) {
      self.sessionId = sessionId
      self.midTurn = midTurn
      self.turnStartedAt = turnStartedAt
      self.cutAt = cutAt
      self.nonce = nonce
      self.why = why
      self.planMode = planMode
      self.escaped = escaped
    }
  }

  /// The file after a death. A death that is no cut also clears an older record: the conversation has moved on, and that cut is
  /// no longer the turn to resume. The re-run marker goes with every death (it either marks this cut, or the launch is over).
  public static func record(_ file: CutTurnFile, _ d: Death) -> CutTurnFile {
    var out = CutTurnFile()
    guard let sid = d.sessionId, !sid.isEmpty, d.midTurn, !d.planMode, !d.escaped else { return out }
    // Fails closed: without the launch's nonce and the turn's start there is no telling what the turn left running from what an earlier
    // turn did, and a turn run again on top of its own leftovers is done twice. Such a cut is not recorded (the caller says so).
    guard let nonce = d.nonce, CutTurnReap.isNonce(nonce), let started = d.turnStartedAt else { return out }
    // the launch that ran a cut turn again and died before any turn of its own ended: the turn that killed it is the one being re-run.
    // A launch whose nonce is not known cannot be told apart, and counts as that one (a turn not resumed is better than one run thrice)
    let fromRerun = file.rerun.map { $0.session_id == sid && $0.nonce == nonce } ?? false
    out.pending = Cut(
      session_id: sid, turn_started_at: ISOTime.string(started), cut_at: ISOTime.string(d.cutAt), nonce: nonce,
      why: d.why.rawValue, from_rerun: fromRerun)
    return out
  }

  public enum Verdict: Equatable, Sendable {
    case none
    case rerun(Cut)
    /// There is a record and it is not used; the words say why (they go to the audit log).
    case skip(String)
  }

  /// Whether this start resumes a cut turn. `resuming`: the start is `--resume` of `sessionId`.
  public static func decide(_ file: CutTurnFile, sessionId: String, resuming: Bool, now: Double) -> Verdict {
    guard let cut = file.pending else { return .none }
    guard resuming else { return .skip("the start is a new conversation") }
    guard cut.session_id == sessionId else { return .skip("the cut turn was in another conversation") }
    if cut.from_rerun { return .skip("the cut turn was a re-run, so it is not run again") }
    guard let at = ISOTime.parse(cut.cut_at) else { return .skip("the record's time cannot be read") }
    guard let n = cut.nonce, CutTurnReap.isNonce(n), cut.turn_started_at.flatMap(ISOTime.parse) != nil else {
      return .skip("the launch or the start of the cut turn is not known, so what it left running cannot be told from the rest")
    }
    let age = now - at
    if age < -skew { return .skip("the clock is behind the cut") }
    if age > window { return .skip("the cut was more than \(Int(window / 60)) minutes ago") }
    return .rerun(cut)
  }

  /// After a re-run is decided: the record is used up, and the launch that runs it is remembered.
  public static func afterConsume(_ file: CutTurnFile, cut: Cut, newNonce: String) -> CutTurnFile {
    CutTurnFile(pending: nil, rerun: Rerun(session_id: cut.session_id, nonce: newNonce))
  }

  /// After a record that is not used: gone (it would only be asked again at every start).
  public static func afterSkip(_ file: CutTurnFile) -> CutTurnFile { CutTurnFile(pending: nil, rerun: file.rerun) }

  /// The re-run's turn finished: a later cut of that launch is an ordinary one.
  public static func turnEnded(_ file: CutTurnFile) -> CutTurnFile { CutTurnFile(pending: file.pending, rerun: nil) }

  // MARK: the file

  public static func path(talosHome: String, threadId: String) -> String { "\(talosHome)/workers/\(threadId)/cut-turn.json" }

  /// A missing file is no record. A file that cannot be read is no record too, but it says so (`problem`), so the caller records it where
  /// the owner can see it: a read that fails is never "nothing happened".
  public static func load(_ path: String) -> (file: CutTurnFile, problem: String?) {
    guard let data = FileManager.default.contents(atPath: path) else {
      return (CutTurnFile(), FileManager.default.fileExists(atPath: path) ? "the file could not be read" : nil)
    }
    guard let f = try? JSONDecoder().decode(CutTurnFile.self, from: data) else { return (CutTurnFile(), "the file is not a cut-turn record") }
    return (f, nil)
  }

  /// An empty file (nothing pending, nothing running) is removed rather than written.
  public static func save(_ file: CutTurnFile, to path: String) throws {
    if file == CutTurnFile() {
      if FileManager.default.fileExists(atPath: path) { try FileManager.default.removeItem(atPath: path) }
      return
    }
    let enc = JSONEncoder()
    enc.outputFormatting = [.sortedKeys]
    try AtomicFile.write(try enc.encode(file), to: path, mode: 0o600)
  }
}

/// A launch's nonce is 32 or more lower-case hex digits (`WorkerManager.nonce()` makes 32): anything else matches nothing, so a short or
/// odd value can never stand for "every process that has some nonce".
public enum CutTurnReap {
  public static func isNonce(_ s: String) -> Bool { s.count >= 32 && s.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) } }
}

/// How the last screen says a turn ended, for the two cases that are no cut: the session was in plan mode, or the owner stopped the
/// turn with Esc. Read from Claude Code's own marks (real captures: Fixtures/real-2.1.318/after-esc, real-2.1.325-status/idle-plan):
/// the status row under the input box says `⏸ plan mode on`; an Esc leaves `⎿  Interrupted · What should Claude do instead?` under the
/// newest prompt. Words in the conversation do not count: only the row under the box, and only an interruption after the newest prompt.
public enum CutTurnScreen {
  public struct Read: Equatable, Sendable {
    public var planMode: Bool
    public var escaped: Bool
    public init(planMode: Bool, escaped: Bool) {
      self.planMode = planMode
      self.escaped = escaped
    }
  }

  static func isRule(_ row: String) -> Bool {
    let t = row.trimmingCharacters(in: .whitespaces)
    return t.count >= 10 && t.allSatisfy { $0 == "─" }
  }

  /// Claude Code's own row under an Esc'd turn: its two-space indent, the corner, the words, nothing else. A tool's output that prints
  /// the words is indented deeper, prefixed or followed by more, and is not an Esc (the Linux side's INTERRUPT_LINE, the same rule).
  static func interruptLine(_ row: String) -> Bool {
    row.range(of: #"^ {2}⎿\s+Interrupted · What should Claude do instead\?\s*$"#, options: .regularExpression) != nil
  }

  public static func read(_ rows: [String]) -> Read {
    let rules = rows.indices.filter { isRule(rows[$0]) }
    var conversation = rows[...]
    var below: [String] = []
    if rules.count >= 2, let bottom = rules.last {
      conversation = rows[..<rules[rules.count - 2]]
      below = Array(rows[(bottom + 1)...])
    }
    let plan = below.contains { $0.trimmingCharacters(in: .whitespaces).hasPrefix("⏸ plan mode on") }
    var escaped = false
    if let prompt = conversation.lastIndex(where: { $0.hasPrefix("❯ ") || $0.hasPrefix("❯\u{00A0}") }) {
      escaped = conversation[prompt...].contains(where: interruptLine)
    }
    return Read(planMode: plan, escaped: escaped)
  }
}
