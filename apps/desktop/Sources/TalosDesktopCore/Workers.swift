import Foundation

/// The files the supervisor shares with main's bridge for Option C (docs/OPTION-C.md "Files"), and the pure rules the
/// worker manager runs on: cap and LRU, idle parking and the pointer typing guard. The JSON shapes
/// match `packages/protocol/src/thread-sessions.ts`; the tests decode the protocol's own fixtures.

// MARK: workers.json

public struct WorkersFile: Codable, Equatable, Sendable {
  public struct Supervisor: Codable, Equatable, Sendable {
    public var pid: Int32
    public var heartbeat_at: String
    public var workers_supported: Bool
    public var main_pane_pid: Int32
    enum CodingKeys: String, CodingKey { case pid, heartbeat_at, workers_supported, main_pane_pid }
    public init(pid: Int32, heartbeat_at: String, workers_supported: Bool, main_pane_pid: Int32) {
      self.pid = pid
      self.heartbeat_at = heartbeat_at
      self.workers_supported = workers_supported
      self.main_pane_pid = main_pane_pid
    }
    public init(from d: Decoder) throws {
      let c = try d.container(keyedBy: CodingKeys.self)
      pid = try c.decode(Int32.self, forKey: .pid)
      heartbeat_at = try c.decode(String.self, forKey: .heartbeat_at)
      workers_supported = try c.decodeIfPresent(Bool.self, forKey: .workers_supported) ?? false
      main_pane_pid = try c.decodeIfPresent(Int32.self, forKey: .main_pane_pid) ?? 0
    }
  }

  public struct ErrorInfo: Codable, Equatable, Sendable {
    public var code: String
    public var detail: String?
    public var at: String
    /// With `mode_escalation_denied`: which axis of the privilege ceiling the spec was over (`permission_mode`, `mcp`, `deny_rules`).
    public var axis: String?
    public init(code: String, detail: String? = nil, at: String, axis: String? = nil) {
      self.code = code
      self.detail = detail
      self.at = at
      self.axis = axis
    }
  }

  /// The folder, model, effort and MCP list a running session was started with (`launched` in the protocol's WorkerEntry). Read tolerantly:
  /// what cannot be read is no record, which never restarts a session.
  public struct Launched: Codable, Equatable, Sendable {
    public var cwd: String
    public var model: String
    public var effort: String?
    /// nil = no list; a list that cannot be read is the empty list, as the protocol reads it.
    public var mcp_allow: [String]?

    public init(cwd: String, model: String, effort: String?, mcp_allow: [String]?) {
      self.cwd = cwd
      self.model = model
      self.effort = effort
      self.mcp_allow = mcp_allow
    }

    enum CodingKeys: String, CodingKey { case cwd, model, effort, mcp_allow }

    public init(from d: Decoder) throws {
      let c = try d.container(keyedBy: CodingKeys.self)
      let cwd = try c.decode(String.self, forKey: .cwd)
      guard cwd.hasPrefix("/") else { throw DecodingError.dataCorruptedError(forKey: .cwd, in: c, debugDescription: "not absolute") }
      self.cwd = cwd
      model = try c.decodeIfPresent(String.self, forKey: .model) ?? "inherit"
      effort = (try? c.decodeIfPresent(String.self, forKey: .effort)) ?? nil
      if c.contains(.mcp_allow) {
        let list = (try? c.decode([String].self, forKey: .mcp_allow)) ?? nil
        mcp_allow = list.flatMap { McpAllow.isValid($0) ? $0 : nil } ?? []
      } else {
        mcp_allow = nil
      }
    }

    public func encode(to e: Encoder) throws {
      var c = e.container(keyedBy: CodingKeys.self)
      try c.encode(cwd, forKey: .cwd)
      try c.encode(model, forKey: .model)
      try c.encodeIfPresent(effort, forKey: .effort)
      try c.encodeIfPresent(mcp_allow, forKey: .mcp_allow)
    }
  }

  public struct Entry: Codable, Equatable, Sendable {
    public var state: String
    public var session_id: String?
    public var previous_ids: [String]
    public var tmux: String
    public var pane_pid: Int32
    public var cwd: String
    public var model: String
    public var started_at: String?
    public var last_turn_at: String?
    public var parked_at: String?
    public var restarts: [String]
    public var error: ErrorInfo?
    /// The claim deadline of a pointer the thread's session is owed (ISO time), and whether its text is in Claude's input box without
    /// its Enter. Written only while set, so a file owing nothing is the file of every earlier build, and read as nothing when absent.
    public var pointer_owed_until: String?
    public var enter_owed: Bool?
    /// The worker's last real activity (ISO time): a pointer, a change on the screen above the input box, an attached client's key. Written
    /// while the worker has a pane, so a relaunched app carries the idle clock on; absent otherwise, and a value that is not a time reads
    /// as absent.
    public var last_active_at: String?
    /// The known dialog on this worker's pane that a tap can answer (needs-you prompts). Present while it is on screen.
    public var dialog: DialogOffer?
    /// What the running session was started with. Written at each start; absent in a file an older build wrote.
    public var launched: Launched?

    enum CodingKeys: String, CodingKey {
      case state, session_id, previous_ids, tmux, pane_pid, cwd, model, started_at, last_turn_at, parked_at, restarts, error
      case pointer_owed_until, enter_owed, last_active_at, dialog, launched
    }

    public init(threadId: String, cwd: String, model: String = "inherit") {
      state = "off"
      session_id = nil
      previous_ids = []
      tmux = WorkerSpec.tmuxName(threadId)
      pane_pid = 0
      self.cwd = cwd
      self.model = model
      started_at = nil
      last_turn_at = nil
      parked_at = nil
      restarts = []
      error = nil
      pointer_owed_until = nil
      enter_owed = nil
      last_active_at = nil
      dialog = nil
      launched = nil
    }

    public init(from d: Decoder) throws {
      let c = try d.container(keyedBy: CodingKeys.self)
      state = try c.decode(String.self, forKey: .state)
      session_id = try c.decodeIfPresent(String.self, forKey: .session_id)
      previous_ids = try c.decodeIfPresent([String].self, forKey: .previous_ids) ?? []
      tmux = try c.decode(String.self, forKey: .tmux)
      pane_pid = try c.decodeIfPresent(Int32.self, forKey: .pane_pid) ?? 0
      cwd = try c.decode(String.self, forKey: .cwd)
      model = try c.decodeIfPresent(String.self, forKey: .model) ?? "inherit"
      started_at = try c.decodeIfPresent(String.self, forKey: .started_at)
      last_turn_at = try c.decodeIfPresent(String.self, forKey: .last_turn_at)
      parked_at = try c.decodeIfPresent(String.self, forKey: .parked_at)
      restarts = try c.decodeIfPresent([String].self, forKey: .restarts) ?? []
      error = try c.decodeIfPresent(ErrorInfo.self, forKey: .error)
      pointer_owed_until = try c.decodeIfPresent(String.self, forKey: .pointer_owed_until)
      enter_owed = try c.decodeIfPresent(Bool.self, forKey: .enter_owed)
      last_active_at = ((try? c.decodeIfPresent(String.self, forKey: .last_active_at)) ?? nil).flatMap { ISOTime.parse($0) == nil ? nil : $0 }
      // a `dialog` this build can't read is no dialog, never an unreadable file
      dialog = ((try? c.decodeIfPresent(DialogOffer.self, forKey: .dialog)) ?? nil).flatMap { $0.isValid ? $0 : nil }
      // a `launched` this build can't read is no record, never an unreadable file
      launched = (try? c.decodeIfPresent(Launched.self, forKey: .launched)) ?? nil
    }

    /// Explicit nulls, like the protocol's schema writes them.
    public func encode(to e: Encoder) throws {
      var c = e.container(keyedBy: CodingKeys.self)
      try c.encode(state, forKey: .state)
      try c.encode(session_id, forKey: .session_id)
      try c.encode(previous_ids, forKey: .previous_ids)
      try c.encode(tmux, forKey: .tmux)
      try c.encode(pane_pid, forKey: .pane_pid)
      try c.encode(cwd, forKey: .cwd)
      try c.encode(model, forKey: .model)
      try c.encode(started_at, forKey: .started_at)
      try c.encode(last_turn_at, forKey: .last_turn_at)
      try c.encode(parked_at, forKey: .parked_at)
      try c.encode(restarts, forKey: .restarts)
      try c.encode(error, forKey: .error)
      try c.encodeIfPresent(pointer_owed_until, forKey: .pointer_owed_until)
      try c.encodeIfPresent(enter_owed, forKey: .enter_owed)
      try c.encodeIfPresent(last_active_at, forKey: .last_active_at)
      try c.encodeIfPresent(dialog, forKey: .dialog)
      try c.encodeIfPresent(launched, forKey: .launched)
    }
  }

  public var v: Int
  public var supervisor: Supervisor
  public var threads: [String: Entry]

  public init(supervisor: Supervisor, threads: [String: Entry] = [:]) {
    v = 1
    self.supervisor = supervisor
    self.threads = threads
  }

  public static func decode(_ data: Data) -> WorkersFile? {
    guard let f = try? JSONDecoder().decode(WorkersFile.self, from: data), f.v == 1 else { return nil }
    return f
  }

  public func encoded() throws -> Data {
    let e = JSONEncoder()
    e.outputFormatting = [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes]
    return try e.encode(self)
  }

  public static let liveStates: Set<String> = ["starting", "live", "busy"]
  /// States with no process behind them. Anything else in a file (a newer copy's state included) may be running.
  public static let restingStates: Set<String> = ["off", "parked", "failed"]

  /// Whether any thread's own session may have a process behind it.
  public var anyMayBeRunning: Bool { threads.values.contains { !Self.restingStates.contains($0.state) } }
}

// MARK: wake file

public struct WakeFile: Codable, Equatable, Sendable {
  public var v: Int
  public var thread_id: String
  public var message_ids: [String]
  public var at: String
  public var reason: String
  public var action: String

  public static let actions: Set<String> = ["pointer", "park", "restart", "fresh", "resume"]

  public init(thread_id: String, message_ids: [String], at: String, reason: String = "message", action: String = "pointer") {
    v = 1
    self.thread_id = thread_id
    self.message_ids = message_ids
    self.at = at
    self.reason = reason
    self.action = action
  }

  public init(from d: Decoder) throws {
    let c = try d.container(keyedBy: CodingKeys.self)
    v = try c.decode(Int.self, forKey: .v)
    thread_id = try c.decode(String.self, forKey: .thread_id)
    message_ids = try c.decodeIfPresent([String].self, forKey: .message_ids) ?? []
    at = try c.decode(String.self, forKey: .at)
    reason = try c.decodeIfPresent(String.self, forKey: .reason) ?? "message"
    action = try c.decodeIfPresent(String.self, forKey: .action) ?? "pointer"
  }

  /// A wake the supervisor may act on: right version, a thread id, a known action, and ids for a pointer.
  public static func decode(_ data: Data) -> WakeFile? {
    guard let w = try? JSONDecoder().decode(WakeFile.self, from: data), w.v == 1,
      WorkerSpec.isThreadId(w.thread_id), actions.contains(w.action),
      w.action != "pointer" || !w.message_ids.isEmpty
    else { return nil }
    return w
  }
}

// MARK: the thread settings, read from the agent config (`$TALOS_APP_HOME/config.json`)

public struct ThreadSessionSettings: Equatable, Sendable {
  public var threadId: String
  public var cwd: String?
  public var model: String
  public var effort: String?
  public var idleParkMin: Int
  /// The MCP servers this session may use besides `talos-app`. nil = no list (today's behaviour); a list, even an empty one, means only those.
  public var mcpAllow: [String]?
  public init(
    threadId: String, cwd: String? = nil, model: String = "inherit", effort: String? = nil, idleParkMin: Int = 30,
    mcpAllow: [String]? = nil
  ) {
    self.threadId = threadId
    self.cwd = cwd
    self.model = model
    self.effort = effort
    self.idleParkMin = idleParkMin
    self.mcpAllow = mcpAllow
  }
}

/// The allow list as the protocol's `McpAllowList` reads it (packages/protocol/src/thread-sessions.ts).
public enum McpAllow {
  static let max = 32
  static let nameMax = 80

  private static func isBad(_ s: Unicode.Scalar) -> Bool {
    switch s.value {
    case 0...0x1f, 0x7f...0x9f, 0x2028, 0x2029, 0x200b...0x200f, 0x202a...0x202e, 0x2066...0x2069, 0xfeff, 0x2c: return true
    default: return false
    }
  }

  public static func isValid(name: String) -> Bool {
    let scalars = Array(name.unicodeScalars)
    guard let first = scalars.first, let last = scalars.last, name.utf16.count <= nameMax else { return false }
    let space = CharacterSet.whitespacesAndNewlines
    return !scalars.contains(where: isBad) && !space.contains(first) && !space.contains(last)
  }

  public static func isValid(_ list: [String]) -> Bool {
    list.count <= max && Set(list).count == list.count && list.allSatisfy { isValid(name: $0) }
  }

  /// A list as read from the config: absent is no list; a value that cannot be read is the empty list, never "no list".
  static func read(_ raw: Any?) -> [String]? {
    guard let raw else { return nil }
    guard let list = raw as? [String], isValid(list) else { return [] }
    return list
  }
}

public struct DedicatedSettings: Equatable, Sendable {
  public var enabled: Bool
  public var maxLive: Int
  /// Dedicated threads, after the same front-door rules as the protocol's `threadSessionMode`.
  public var threads: [String: ThreadSessionSettings]

  public static let off = DedicatedSettings(enabled: false, maxLive: 3, threads: [:])
  public static let neverDedicated: Set<String> = ["general", "inbox"]

  /// Parses the agent config. Anything missing or odd reads as off; a thread that can't be dedicated is left out.
  public static func parse(_ data: Data) -> DedicatedSettings { readable(data) ?? .off }

  /// nil when the file isn't a JSON object: a half-saved hand edit must not read as "off" and park every worker.
  public static func readable(_ data: Data) -> DedicatedSettings? {
    guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
    // present but not what we wrote: unreadable, not "off"
    if let raw = root["dedicated"], !(raw is [String: Any]) { return nil }
    let d = root["dedicated"] as? [String: Any]
    if let raw = d?["enabled"], !(raw is Bool) { return nil }
    guard d?["enabled"] as? Bool == true else { return .off }
    if let raw = root["threads"], !(raw is [[String: Any]]) { return nil }
    let maxLive = min(6, max(1, (d?["max_live"] as? Int) ?? 3))
    let defaultThread = root["default_thread"] as? String
    var out: [String: ThreadSessionSettings] = [:]
    for t in (root["threads"] as? [[String: Any]]) ?? [] {
      guard let id = t["id"] as? String, WorkerSpec.isThreadId(id), t["session"] as? String == "dedicated",
        t["kind"] as? String != "system", t["archived"] as? Bool != true, id != defaultThread,
        !neverDedicated.contains(id)
      else { continue }
      let o = t["session_opts"] as? [String: Any] ?? [:]
      // present but not an object: the empty list, never no list
      let broken = t["session_opts"] != nil && !(t["session_opts"] is NSNull) && !(t["session_opts"] is [String: Any])
      let idle = min(720, max(5, (o["idle_park_min"] as? Int) ?? 30))
      out[id] = ThreadSessionSettings(
        threadId: id, cwd: o["cwd"] as? String, model: (o["model"] as? String) ?? "inherit",
        effort: o["effort"] as? String, idleParkMin: idle, mcpAllow: broken ? [] : McpAllow.read(o["mcp_allow"]))
    }
    return DedicatedSettings(enabled: true, maxLive: maxLive, threads: out)
  }
}

// MARK: cap and parking

public enum WorkerPolicy {
  public enum StartPlan: Equatable, Sendable {
    case start
    /// Park this idle worker first to make room.
    case parkThenStart(String)
    /// Every slot is busy: hold the wake.
    case hold
  }

  public struct Live: Equatable, Sendable {
    public var threadId: String
    public var busy: Bool
    /// Seconds since 1970 of the last pointer, change on the screen above the input box, or key from an attached client.
    public var lastActive: Double
    public init(threadId: String, busy: Bool, lastActive: Double) {
      self.threadId = threadId
      self.busy = busy
      self.lastActive = lastActive
    }
  }

  /// Room for one more worker? Parks the longest-idle non-busy one when full (OPTION-C 2.6).
  public static func planStart(live: [Live], maxLive: Int) -> StartPlan {
    if live.count < maxLive { return .start }
    let idle = live.filter { !$0.busy }.sorted { ($0.lastActive, $0.threadId) < ($1.lastActive, $1.threadId) }
    if let victim = idle.first { return .parkThenStart(victim.threadId) }
    return .hold
  }

  /// A crash counts toward the loop cap; 5 in 15 min = `failed: crash_loop` (OPTION-C 2.5).
  public static func crashLooping(restarts: [Double], now: Double, cap: Int = 5, window: Double = 900) -> Bool {
    restarts.filter { now - $0 < window }.count >= cap
  }
}

// MARK: the pointer

public enum PointerTyper {
  /// The only text the supervisor ever types into a worker. Same as the protocol's WORKER_POINTER_TEXT.
  public static let text = "Talos: new message in this thread. Call read_inbound."
  public static let quietSeconds: Double = 10
  /// How long the hub waits for a `read_inbound` claim before it gives the message to main (the protocol's CLAIM_DEADLINE_MS and
  /// CLAIM_DEADLINE_COLD_MS, in seconds; `CLAIM_DEADLINE_COLD_MS` when the wake had to start the worker). A test reads the protocol file.
  public static let claimDeadline: Double = 90
  public static let claimDeadlineCold: Double = 120

  /// Type only at the normal prompt (no dialog on screen), only when Claude's input box is on the screen (`boxVisible`: a blank
  /// pane, a banner without a box, or a dialog caught mid-draw has nowhere to take a line), only when that box holds no draft,
  /// and only when no attached client typed in the last 10 s. The draft check does not depend on a client being attached: the
  /// owner who typed half a line and switched to another session has detached.
  public static func mayType(
    screen: DialogMatcher.Screen, lastClientActivity: Double?, now: Double, draftPresent: Bool, boxVisible: Bool
  ) -> Bool {
    guard screen == .none, boxVisible, !draftPresent else { return false }
    if let t = lastClientActivity, t > 0, now - t < quietSeconds { return false }
    return true
  }

  /// Whether Claude's input box holds text the owner typed. Read from real 2.1.318 captures (Tests/Fixtures/real-2.1.318): the box
  /// is two rule rows with the input between them; its first row is `❯` + U+00A0 (not an ASCII space) + the text, and a long
  /// draft continues on indented rows. Earlier user messages in the history are drawn `❯` + an ASCII space, outside the box, and
  /// are never the input. An empty box shows nothing after the glyph, or a dim placeholder or suggestion (`InputBoxAttributes`
  /// tells that from text by its colours); plain text cannot, so any text here counts as a draft. A
  /// screen with no box found says no draft (the dialog and busy checks apply there).
  public static func draftPresent(rows: [String]) -> Bool { !(boxText(rows: rows) ?? "").isEmpty }

  /// What Claude's input box holds, its rows joined and every run of white space (the U+00A0 after `❯` included) made one space; nil
  /// when no box is on the screen. Our own pointer line reads as `text` exactly when Claude wraps a long line at spaces (checked on real 2.1.319 captures at 120, 40 and 30 columns).
  public static func boxText(rows: [String]) -> String? {
    guard let box = inputBox(rows: rows) else { return nil }
    let inner = Array(rows[box])
    let text = ([String(inner[0].drop(while: { $0 == " " }).dropFirst())] + inner.dropFirst()).joined(separator: " ")
    return text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
  }

  /// The rows between the two rules of Claude's input box (the first of them starts with `❯`), nil when no box is on the screen. The
  /// box is the LAST pair of rule rows with a `❯` row first between them; older rules above, a dialog's option rows (`❯ 1. Yes`,
  /// which have no rule row after them in that shape) and a blank or banner-only pane are not one. The one definition: the draft
  /// check, the colour check (`InputBoxAttributes`) and the typing guard (`mayType`'s `boxVisible`) all use it.
  public static func inputBox(rows: [String]) -> Range<Int>? {
    let rules = rows.indices.filter { DialogMatcher.isFrameRule(rows[$0]) }
    guard rules.count >= 2 else { return nil }
    for k in stride(from: rules.count - 2, through: 0, by: -1) {
      let a = rules[k], b = rules[k + 1]
      guard b - a >= 2, rows[a + 1].drop(while: { $0 == " " }).first == DialogMatcher.Strings.pointer else { continue }
      return (a + 1)..<b
    }
    return nil
  }
}

public enum ISOTime {
  public static func string(_ t: Double) -> String {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f.string(from: Date(timeIntervalSince1970: t))
  }

  public static func parse(_ s: String) -> Double? {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = f.date(from: s) { return d.timeIntervalSince1970 }
    f.formatOptions = [.withInternetDateTime]
    return f.date(from: s)?.timeIntervalSince1970
  }
}
