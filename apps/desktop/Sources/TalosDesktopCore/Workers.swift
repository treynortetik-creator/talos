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
    /// This build can launch sub-threads. The bridge refuses a new `parent_id` until it reads true. Absent, or anything but a boolean, reads false.
    public var subthreads_supported: Bool
    /// This build also starts a dedicated sub-thread in an existing folder outside its parent's. Written only when true; absent reads false.
    public var subthreads_own_folder: Bool
    /// This build also starts a dedicated sub-thread with no folder, or its parent's own, in the parent's folder. Written only when true.
    public var subthreads_shared_folder: Bool
    public var main_pane_pid: Int32
    /// Main's own dialog on its pane (the development-channels warning), published here because Main has no thread entry. The bridge makes
    /// a card from it for the default thread. A value that does not fit reads as none.
    public var main_dialog: DialogOffer?
    enum CodingKeys: String, CodingKey { case pid, heartbeat_at, workers_supported, subthreads_supported, subthreads_own_folder, subthreads_shared_folder, main_pane_pid, main_dialog }
    public init(
      pid: Int32, heartbeat_at: String, workers_supported: Bool, main_pane_pid: Int32, main_dialog: DialogOffer? = nil,
      subthreads_supported: Bool = false, subthreads_own_folder: Bool = false, subthreads_shared_folder: Bool = false
    ) {
      self.pid = pid
      self.heartbeat_at = heartbeat_at
      self.workers_supported = workers_supported
      self.subthreads_supported = subthreads_supported
      self.subthreads_own_folder = subthreads_own_folder
      self.subthreads_shared_folder = subthreads_shared_folder
      self.main_pane_pid = main_pane_pid
      self.main_dialog = main_dialog
    }
    public init(from d: Decoder) throws {
      let c = try d.container(keyedBy: CodingKeys.self)
      pid = try c.decode(Int32.self, forKey: .pid)
      heartbeat_at = try c.decode(String.self, forKey: .heartbeat_at)
      workers_supported = try c.decodeIfPresent(Bool.self, forKey: .workers_supported) ?? false
      subthreads_supported = ((try? c.decodeIfPresent(Bool.self, forKey: .subthreads_supported)) ?? nil) ?? false
      subthreads_own_folder = ((try? c.decodeIfPresent(Bool.self, forKey: .subthreads_own_folder)) ?? nil) ?? false
      subthreads_shared_folder = ((try? c.decodeIfPresent(Bool.self, forKey: .subthreads_shared_folder)) ?? nil) ?? false
      main_pane_pid = try c.decodeIfPresent(Int32.self, forKey: .main_pane_pid) ?? 0
      main_dialog = ((try? c.decodeIfPresent(DialogOffer.self, forKey: .main_dialog)) ?? nil).flatMap { $0.isValid ? $0 : nil }
    }
    /// `subthreads_supported` is written only when true: a false and an absent key mean the same, and a reader that does not know the key sees nothing new.
    public func encode(to e: Encoder) throws {
      var c = e.container(keyedBy: CodingKeys.self)
      try c.encode(pid, forKey: .pid)
      try c.encode(heartbeat_at, forKey: .heartbeat_at)
      try c.encode(workers_supported, forKey: .workers_supported)
      if subthreads_supported { try c.encode(true, forKey: .subthreads_supported) }
      if subthreads_own_folder { try c.encode(true, forKey: .subthreads_own_folder) }
      if subthreads_shared_folder { try c.encode(true, forKey: .subthreads_shared_folder) }
      try c.encode(main_pane_pid, forKey: .main_pane_pid)
      try c.encodeIfPresent(main_dialog, forKey: .main_dialog)
    }
  }

  public struct ErrorInfo: Codable, Equatable, Sendable {
    public var code: String
    public var detail: String?
    public var at: String
    /// With `mode_escalation_denied`: which axis of the privilege ceiling the spec was over (`permission_mode`, `mcp`, `deny_rules`).
    public var axis: String?
    /// The most `detail` may be: the protocol reads it in UTF-16 units (`WorkersFile` in packages/protocol/src/thread-sessions.ts).
    public static let detailUnits = 300

    /// A detail as it is written: at most `detailUnits` UTF-16 units, cut between characters, so never through a surrogate pair. A
    /// count in characters lets a detail of characters outside the BMP (a folder's name) through at up to twice the length.
    public static func clipDetail(_ s: String) -> String { TerminalSessions.clamp(s, units: detailUnits) }

    public init(code: String, detail: String? = nil, at: String, axis: String? = nil) {
      self.code = code
      self.detail = detail
      self.at = at
      self.axis = axis
    }
  }

  /// What a session waits on the owner for (`needs_you` in the protocol's WorkerEntry): a dialog's or prompt's name, clipped to
  /// `kindUnits`, and since when (ISO time). Main's own is in `main-restart-check.json`, in the same shape.
  /// `resets_at` (ISO time): the usage-limit screen's reset, the next such moment after it was read (`UsageLimitScreen.resetsAt`);
  /// only for that kind, absent when it could not be worked out. One this build can't read is dropped alone, never the whole needs-you.
  public struct NeedsYou: Codable, Equatable, Sendable {
    public var kind: String
    public var since: String
    public var resets_at: String?
    public static let kindUnits = 80
    public init(kind: String, since: String, resets_at: String? = nil) {
      self.kind = TerminalSessions.clamp(kind, units: Self.kindUnits)
      self.since = since
      self.resets_at = resets_at
    }
    enum CodingKeys: String, CodingKey { case kind, since, resets_at }
    public init(from d: Decoder) throws {
      let c = try d.container(keyedBy: CodingKeys.self)
      kind = try c.decode(String.self, forKey: .kind)
      since = try c.decode(String.self, forKey: .since)
      resets_at = ((try? c.decodeIfPresent(String.self, forKey: .resets_at)) ?? nil).flatMap { ISOTime.parse($0) == nil ? nil : $0 }
    }
    var isValid: Bool { !kind.isEmpty && ISOTime.parse(since) != nil }
  }

  /// Why a session is parked or stopping (`stopped_why`): the closed list the protocol reads (WORKER_STOPPED_WHY).
  public static let stoppedWhyValues: Set<String> = ["idle", "cap", "owner", "crash", "interrupted", "restart", "governor"]

  /// The folder, model, effort and MCP list a running session was started with (`launched` in the protocol's WorkerEntry). Read tolerantly:
  /// what cannot be read is no record, which never restarts a session.
  public struct Launched: Codable, Equatable, Sendable {
    public var cwd: String
    public var model: String
    public var effort: String?
    /// nil = no list; a list that cannot be read is the empty list, as the protocol reads it.
    public var mcp_allow: [String]?
    /// The launch spec's hash at this start (`LaunchSpecHash`, restart on update); nil when it could not be made, or an older build
    /// started it: then it reads as older. `update_tried_hash`: the spec an update restart was last tried for, kept across the start
    /// it gives, so no spec is tried twice. A value that is not a hash reads as absent.
    public var spec_hash: String?
    public var update_tried_hash: String?
    /// The digest of the instructions this start handed a session outside the agent folder (`LaunchSpecHash.Parts.instructionsHash`),
    /// so the update check can say an instruction edit alone ("instructions changed"); nil in the agent folder (that folder's files
    /// are loaded by the session itself, never hashed) and from an older build. A value that is not a hash reads as absent.
    public var instructions_hash: String?

    public init(
      cwd: String, model: String, effort: String?, mcp_allow: [String]?, spec_hash: String? = nil, update_tried_hash: String? = nil,
      instructions_hash: String? = nil
    ) {
      self.cwd = cwd
      self.model = model
      self.effort = effort
      self.mcp_allow = mcp_allow
      self.spec_hash = spec_hash.flatMap { SpecHash.isValid($0) ? $0 : nil }
      self.update_tried_hash = update_tried_hash.flatMap { SpecHash.isValid($0) ? $0 : nil }
      self.instructions_hash = instructions_hash.flatMap { SpecHash.isValid($0) ? $0 : nil }
    }

    enum CodingKeys: String, CodingKey { case cwd, model, effort, mcp_allow, spec_hash, update_tried_hash, instructions_hash }

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
      func hash(_ k: CodingKeys) -> String? { ((try? c.decodeIfPresent(String.self, forKey: k)) ?? nil).flatMap { SpecHash.isValid($0) ? $0 : nil } }
      spec_hash = hash(.spec_hash)
      update_tried_hash = hash(.update_tried_hash)
      instructions_hash = hash(.instructions_hash)
    }

    public func encode(to e: Encoder) throws {
      var c = e.container(keyedBy: CodingKeys.self)
      try c.encode(cwd, forKey: .cwd)
      try c.encode(model, forKey: .model)
      try c.encodeIfPresent(effort, forKey: .effort)
      try c.encodeIfPresent(mcp_allow, forKey: .mcp_allow)
      try c.encodeIfPresent(spec_hash, forKey: .spec_hash)
      try c.encodeIfPresent(update_tried_hash, forKey: .update_tried_hash)
      try c.encodeIfPresent(instructions_hash, forKey: .instructions_hash)
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
    /// The pointer's Enter went and may have answered a prompt (`EnterDetection`): held, never entered again, until its deadline. Written
    /// only while set, so a relaunched app keeps holding it (the Linux supervisor's `enter_uncertain`).
    public var enter_uncertain: Bool?
    /// The worker's last real activity (ISO time): a pointer, a change on the screen above the input box, an attached client's key. Written
    /// while the worker has a pane, so a relaunched app carries the idle clock on; absent otherwise, and a value that is not a time reads
    /// as absent.
    public var last_active_at: String?
    /// The known dialog on this worker's pane that a tap can answer (needs-you prompts). Present while it is on screen.
    public var dialog: DialogOffer?
    /// What the running session was started with. Written at each start; absent in a file an older build wrote.
    public var launched: Launched?
    /// The session id a message was last typed into (with `last_turn_at`), or the id last retired: "has `session_id` ever had a
    /// turn" is `turn_session == session_id`. Absent in a file an older build wrote; then `last_turn_at` alone answers (`hadTurn`).
    public var turn_session: String?
    /// When the worker was asked to stop after its turn (ISO time), written while it is `stopping`. A relaunched app measures how long
    /// the turn may still run from this, not from its own start. Absent in any other state and in a file an older build wrote; a value
    /// that is not a time reads as absent.
    public var stopping_since: String?
    /// What the session waits on the owner for right now: raised with the `worker_needs_you` line, gone when the prompt is. Absent otherwise.
    public var needs_you: NeedsYou?
    /// Why it is parked or on its way out (`WorkersFile.stoppedWhyValues`); cleared at each start. Absent in a file an older build wrote.
    public var stopped_why: String?
    /// When the running turn began (a pointer typed into it, ISO time); cleared when it ends, when `last_turn_at` takes the end.
    public var turn_started_at: String?

    /// Whether the conversation `session_id` has had a turn (a message typed into it). One that has, and whose file is not found,
    /// is lost, not unsaved: it is resumed (and fails as `resume_missing`), never quietly started over under the same id.
    public var hadTurn: Bool {
      guard let sid = session_id else { return false }
      if let ts = turn_session { return ts == sid }
      return last_turn_at != nil
    }

    enum CodingKeys: String, CodingKey {
      case state, session_id, previous_ids, tmux, pane_pid, cwd, model, started_at, last_turn_at, parked_at, restarts, error
      case pointer_owed_until, enter_owed, enter_uncertain, last_active_at, dialog, launched, turn_session, stopping_since
      case needs_you, stopped_why, turn_started_at
    }

    /// The id moves to `previous_ids` (last 5) and the next start makes a new one: [Start fresh], and a conversation file that
    /// holds nothing to resume.
    public mutating func retireSessionId() {
      if let old = session_id {
        previous_ids = Array((previous_ids + [old]).suffix(5))
        turn_session = old  // whatever comes next is another conversation: the old one's turns are not its turns
      }
      session_id = nil
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
      enter_uncertain = nil
      last_active_at = nil
      dialog = nil
      launched = nil
      turn_session = nil
      stopping_since = nil
      needs_you = nil
      stopped_why = nil
      turn_started_at = nil
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
      // added late: what this build can't read is not set, never an unreadable entry
      enter_uncertain = ((try? c.decodeIfPresent(Bool.self, forKey: .enter_uncertain)) ?? nil) == true ? true : nil
      last_active_at = ((try? c.decodeIfPresent(String.self, forKey: .last_active_at)) ?? nil).flatMap { ISOTime.parse($0) == nil ? nil : $0 }
      // a `dialog` this build can't read is no dialog, never an unreadable file
      dialog = ((try? c.decodeIfPresent(DialogOffer.self, forKey: .dialog)) ?? nil).flatMap { $0.isValid ? $0 : nil }
      // a `launched` this build can't read is no record, never an unreadable file
      launched = (try? c.decodeIfPresent(Launched.self, forKey: .launched)) ?? nil
      turn_session = (try? c.decodeIfPresent(String.self, forKey: .turn_session)) ?? nil
      stopping_since = ((try? c.decodeIfPresent(String.self, forKey: .stopping_since)) ?? nil).flatMap { ISOTime.parse($0) == nil ? nil : $0 }
      // added late and all three optional: what this build can't read is none, never an unreadable entry
      needs_you = ((try? c.decodeIfPresent(NeedsYou.self, forKey: .needs_you)) ?? nil).flatMap { $0.isValid ? $0 : nil }
      stopped_why = ((try? c.decodeIfPresent(String.self, forKey: .stopped_why)) ?? nil).flatMap { $0.isEmpty ? nil : $0 }
      turn_started_at = ((try? c.decodeIfPresent(String.self, forKey: .turn_started_at)) ?? nil).flatMap { ISOTime.parse($0) == nil ? nil : $0 }
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
      try c.encodeIfPresent(enter_uncertain, forKey: .enter_uncertain)
      try c.encodeIfPresent(last_active_at, forKey: .last_active_at)
      try c.encodeIfPresent(dialog, forKey: .dialog)
      try c.encodeIfPresent(launched, forKey: .launched)
      try c.encodeIfPresent(turn_session, forKey: .turn_session)
      try c.encodeIfPresent(stopping_since, forKey: .stopping_since)
      try c.encodeIfPresent(needs_you, forKey: .needs_you)
      try c.encodeIfPresent(stopped_why, forKey: .stopped_why)
      try c.encodeIfPresent(turn_started_at, forKey: .turn_started_at)
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
  /// Set for a sub-thread: what the launcher checks and makes for it. Its options above are already the effective ones.
  public var sub: SubThreads.Launch?
  /// The launch fields of a plain thread's `session_opts` whose value cannot be read (`cwd`, `model`, `effort`), or `session_opts` when
  /// the whole value is not an object. Such a field is not the owner's setting: it is never compared with a running session's launch
  /// (it restarts nothing), and a start whose folder it hides is refused (`unreadFolderField`). The MCP list is not among them: one that
  /// cannot be read is the empty list, and a narrowing is never put off.
  public var optsUnread: [String] = []
  public init(
    threadId: String, cwd: String? = nil, model: String = "inherit", effort: String? = nil, idleParkMin: Int = 30,
    mcpAllow: [String]? = nil, sub: SubThreads.Launch? = nil, optsUnread: [String] = []
  ) {
    self.optsUnread = optsUnread
    self.threadId = threadId
    self.cwd = cwd
    self.model = model
    self.effort = effort
    self.idleParkMin = idleParkMin
    self.mcpAllow = mcpAllow
    self.sub = sub
  }
}

/// The allow list as the protocol's `McpAllowList` reads it (packages/protocol/src/thread-sessions.ts).
extension ThreadSessionSettings {
  /// Whether launch field `f` (`cwd`, `model`, `effort`) cannot be read.
  public func unread(_ f: String) -> Bool { optsUnread.contains("session_opts") || optsUnread.contains(f) }

  /// The setting that hides this thread's folder, as the owner would look for it in config.json; nil when the folder can be read.
  public var unreadFolderField: String? {
    if optsUnread.contains("session_opts") { return "session_opts" }
    return optsUnread.contains("cwd") ? "session_opts.cwd" : nil
  }

  /// Which launch fields of a plain thread's `session_opts` cannot be read. A field that is absent (or null) is not unread: its default
  /// is what the owner chose.
  static func unreadOpts(_ t: [String: Any]) -> [String] {
    guard let raw = t["session_opts"], !(raw is NSNull) else { return [] }
    guard let o = raw as? [String: Any] else { return ["session_opts"] }
    func present(_ k: String) -> Any? {
      guard let v = o[k], !(v is NSNull) else { return nil }
      return v
    }
    var bad: [String] = []
    if let v = present("cwd"), !((v as? String)?.hasPrefix("/") ?? false) { bad.append("cwd") }
    if let v = present("model"), !((v as? String).map(WorkerSpec.isModel) ?? false) { bad.append("model") }
    if let v = present("effort"), !((v as? String).map(SubThreads.isEffort) ?? false) { bad.append("effort") }
    return bad
  }
}

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
  /// The `config.threads` entries that are not a thread (not an object, or an object with no text id or no text `kind`), by position from 1. Each is left
  /// out and the rest is read. Never "the whole config cannot be read": that would keep every session on the last good list, which can
  /// be wider than what the owner just wrote. Leaving one out can only remove threads, and a parent left out makes its sub-threads
  /// orphans, which fail closed. The owner is told (`droppedEntriesLine`).
  public var droppedEntries: [Int] = []
  /// Where that line goes: the config's default thread, `general` when it names none.
  public var defaultThread = "general"
  /// `dedicated.restart_on_update` (restart on update): a junk value is on, the default, never a silent off.
  public var restartOnUpdate = true

  public static let off = DedicatedSettings(enabled: false, maxLive: 3, threads: [:])

  /// What the owner is told about entries that were left out, once per set of them.
  public static func droppedEntriesLine(_ entries: [Int]) -> String {
    let list = entries.map { "#\($0)" }.joined(separator: ", ")
    return entries.count == 1
      ? "config.threads entry \(list) isn't a thread object and was ignored; if it had its own session, that session stops."
      : "config.threads entries \(list) aren't thread objects and were ignored; if they had their own sessions, those sessions stop."
  }
  public static let neverDedicated: Set<String> = ["general", "inbox"]

  /// Whether a `config.threads` entry is a thread as the bridge reads one (`dedicatedThreads`, workers-wiring.ts): an object with a
  /// text id and a text `kind`. The protocol requires `kind` (fixed, agent or system); which text it is is judged later, so a kind a
  /// newer build added costs nothing. An entry without one is no thread on either side, never a thread on the Mac alone.
  static func isThreadEntry(_ raw: Any) -> Bool {
    guard let o = raw as? [String: Any] else { return false }
    return o["id"] is String && o["kind"] is String
  }

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
    if let raw = root["threads"], !(raw is [Any]) { return nil }
    let maxLive = min(6, max(1, (d?["max_live"] as? Int) ?? 3))
    let defaultThread = root["default_thread"] as? String
    var out: [String: ThreadSessionSettings] = [:]
    // an entry that is not a thread is left out, by position; the rest is read
    let entries = (root["threads"] as? [Any]) ?? []
    let all = entries.compactMap { $0 as? [String: Any] }
    let dropped = entries.indices.filter { !Self.isThreadEntry(entries[$0]) }.map { $0 + 1 }
    for t in all where Self.isThreadEntry(t) {
      guard let id = t["id"] as? String, WorkerSpec.isThreadId(id), t["session"] as? String == "dedicated",
        t["kind"] as? String != "system", t["archived"] as? Bool != true, id != defaultThread,
        !neverDedicated.contains(id)
      else { continue }
      // the folder, model, effort and MCP list are the effective ones (a sub-thread inherits what it does not set); the idle time never is
      let eff = SubThreads.effective(t, in: all)
      let idle = SubThreads.idleParkMin(t)
      var sub = SubThreads.launch(t, in: all)
      // a sub-thread's folder is its own (inside its parent's, or an existing one outside), or its parent's (none, or the same: it follows the
      // parent when that moves, and is judged against nothing), and its model and effort are the effective ones; a plain thread's are what it
      // sets, so a value that is not valid still fails the launch
      let raw = t["session_opts"] as? [String: Any] ?? [:]
      var cwd = sub == nil ? eff.cwd : SubThreads.own(t).cwd
      if sub?.shares == true {
        cwd = sub?.parentCwd
        sub?.parentCwd = nil
      }
      out[id] = ThreadSessionSettings(
        threadId: id, cwd: cwd, model: (sub == nil ? raw["model"] as? String : eff.model) ?? "inherit",
        effort: sub == nil ? raw["effort"] as? String : eff.effort, idleParkMin: idle, mcpAllow: eff.mcpAllow, sub: sub,
        optsUnread: sub == nil ? ThreadSessionSettings.unreadOpts(t) : [])
    }
    var settings = DedicatedSettings(enabled: true, maxLive: maxLive, threads: out)
    settings.droppedEntries = dropped
    settings.restartOnUpdate = JSONValue.bool(d?["restart_on_update"]) ?? true
    if let name = defaultThread, WorkerSpec.isThreadId(name) { settings.defaultThread = name }
    return settings
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
    /// Background work runs under it (a Bash tool command still going, or a table that could not be read): never the cap's choice
    /// while a quiet one without any is there (`victims`).
    public var background: Bool
    public init(threadId: String, busy: Bool, lastActive: Double, background: Bool = false) {
      self.threadId = threadId
      self.busy = busy
      self.lastActive = lastActive
      self.background = background
    }
  }

  /// The cap's choices, in order: the quiet ones with no background work, longest idle first; only when every quiet one has some,
  /// those, longest idle first (a park then cuts that work, and its thread is told).
  public static func victims(_ live: [Live]) -> [Live] {
    let quiet = live.filter { !$0.busy }.sorted { ($0.lastActive, $0.threadId) < ($1.lastActive, $1.threadId) }
    let clean = quiet.filter { !$0.background }
    return clean.isEmpty ? quiet : clean
  }

  /// Room for one more worker? Parks the longest-idle non-busy one when full (OPTION-C 2.6), one with no background work first.
  public static func planStart(live: [Live], maxLive: Int) -> StartPlan {
    if live.count < maxLive { return .start }
    if let victim = victims(live).first { return .parkThenStart(victim.threadId) }
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
  /// The longest any message waits for its claim: a hand-off from main to a lead (the bridge's `HANDOFF_CLAIM_MS`), which has no 90/120 s
  /// deadline. A wake older than this names only messages the hub has given back to main.
  public static let longestClaim: Double = 900

  /// Type only at the normal prompt (no dialog on screen), only when Claude's input box is on the screen (`boxVisible`: a blank
  /// pane, a banner without a box, or a dialog caught mid-draw has nowhere to take a line), only when that box holds no draft,
  /// and only when no attached client typed in the last 10 s. The draft check does not depend on a client being attached: the
  /// owner who typed half a line and switched to another session has detached.
  public static func mayType(
    screen: DialogMatcher.Screen, lastClientActivity: Double?, now: Double, draftPresent: Bool, boxVisible: Bool
  ) -> Bool {
    // `.none` only: the usage-limit screen (`takesNoKeys`) is never `.none`, so no line and no Enter go to it
    guard screen == .none, !screen.takesNoKeys, boxVisible, !draftPresent else { return false }
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
