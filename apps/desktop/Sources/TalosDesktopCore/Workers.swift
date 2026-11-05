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
    public init(code: String, detail: String? = nil, at: String) {
      self.code = code
      self.detail = detail
      self.at = at
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

    enum CodingKeys: String, CodingKey {
      case state, session_id, previous_ids, tmux, pane_pid, cwd, model, started_at, last_turn_at, parked_at, restarts, error
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
  public init(threadId: String, cwd: String? = nil, model: String = "inherit", effort: String? = nil, idleParkMin: Int = 30)
  {
    self.threadId = threadId
    self.cwd = cwd
    self.model = model
    self.effort = effort
    self.idleParkMin = idleParkMin
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
      let idle = min(720, max(5, (o["idle_park_min"] as? Int) ?? 30))
      out[id] = ThreadSessionSettings(
        threadId: id, cwd: o["cwd"] as? String, model: (o["model"] as? String) ?? "inherit",
        effort: o["effort"] as? String, idleParkMin: idle)
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
    /// Seconds since 1970 of the last pointer, turn or output.
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

  /// Type only at the normal prompt (no dialog on screen), and only when no attached client typed in the last 10 s.
  public static func mayType(screen: DialogMatcher.Screen, lastClientActivity: Double?, now: Double) -> Bool {
    guard screen == .none else { return false }
    if let t = lastClientActivity, t > 0, now - t < quietSeconds { return false }
    return true
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
