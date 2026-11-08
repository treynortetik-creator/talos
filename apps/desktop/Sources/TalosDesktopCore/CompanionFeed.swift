import Foundation

/// The desktop companion's feed (DESKTOP-COMPANION-SPEC 7): what the web page tells the Mac app in `companion_state`.
/// Counts and thread ids only. Mirror of `packages/protocol/src/native.ts` (NativeCompanionState), decoded strictly at
/// the top level like every other message, with one deliberate exception: a row whose state (or shape) this build does not
/// know is dropped, not the frame. The web updates through the relay and the shell does not, so the page is often newer.
public struct CompanionFeed: Equatable, Sendable {
  public enum Link: String, Sendable { case connecting, online, offline, unreachable }
  public enum RowState: String, Sendable {
    case needsYou = "needs_you", ready, working, queued, onCall = "on_call"
  }
  public struct Row: Equatable, Sendable {
    public var threadId: String
    public var state: RowState
    public init(threadId: String, state: RowState) {
      self.threadId = threadId
      self.state = state
    }
  }
  public struct LastReply: Equatable, Sendable {
    public var threadId: String
    public var seq: Int
    public init(threadId: String, seq: Int) {
      self.threadId = threadId
      self.seq = seq
    }
  }

  public var link: Link
  public var macOnline: Bool
  public var busy: Bool
  public var needs: Int
  public var working: Int
  public var queued: Int
  public var onCall: Int
  public var unread: Int
  public var failed: Int
  public var rows: [Row]
  public var lastReply: LastReply?
  /// The thread on screen by the page's own routing (a card page counts as its thread), else nil.
  public var viewing: String?
  /// Replies the page holds back for him while he delivers (`companion_replies`), one per thread, oldest first.
  public var held: [HeldReply]
  /// The epoch of his last "on" the page has applied (`companion_replies.epoch`), nil while it is off or for an older page. A frame
  /// of an older epoch may list replies the page has since toasted: ignore its `held`.
  public var repliesEpoch: Int?

  public static let maxRows = 12
  static let keys: Set<String> = [
    "link", "mac_online", "busy", "needs", "working", "queued", "on_call", "unread", "failed", "rows", "last_reply",
  ]
  /// Newer pages add these; an older page omits them.
  static let optionalKeys: Set<String> = ["viewing", "held", "replies_epoch"]

  public init(
    link: Link, macOnline: Bool, busy: Bool, needs: Int = 0, working: Int = 0, queued: Int = 0, onCall: Int = 0,
    unread: Int = 0, failed: Int = 0, rows: [Row] = [], lastReply: LastReply? = nil, viewing: String? = nil, held: [HeldReply] = [],
    repliesEpoch: Int? = nil
  ) {
    self.link = link
    self.macOnline = macOnline
    self.busy = busy
    self.needs = needs
    self.working = working
    self.queued = queued
    self.onCall = onCall
    self.unread = unread
    self.failed = failed
    self.rows = rows
    self.lastReply = lastReply
    self.viewing = viewing
    self.held = held
    self.repliesEpoch = repliesEpoch
  }

  /// Decodes the fields of a `companion_state` object (the `type` key already checked). nil = the frame is invalid, and
  /// the caller clears the feed rather than keep an old one standing.
  static func decode(_ o: [String: Any]) -> CompanionFeed? {
    let present = Set(o.keys)
    guard keys.union(["type"]).isSubset(of: present), present.isSubset(of: keys.union(["type"]).union(optionalKeys)),
      let linkRaw = o["link"] as? String, let link = Link(rawValue: linkRaw),
      let macOnline = JSONValue.bool(o["mac_online"]), let busy = JSONValue.bool(o["busy"]),
      let needs = count(o["needs"]), let working = count(o["working"]), let queued = count(o["queued"]),
      let onCall = count(o["on_call"]), let unread = count(o["unread"]), let failed = count(o["failed"]),
      let rawRows = o["rows"] as? [Any]
    else { return nil }
    // One unknown row drops that row, not the frame. A row that is not even an object with these two keys is the same.
    var rows: [Row] = []
    var seen = Set<String>()
    for r in rawRows {
      guard let d = r as? [String: Any], Set(d.keys) == ["thread_id", "state"],
        let id = d["thread_id"] as? String, ThreadIdRule.isValid(id),
        let s = d["state"] as? String, let state = RowState(rawValue: s),
        seen.insert(id).inserted, rows.count < maxRows
      else { continue }
      rows.append(Row(threadId: id, state: state))
    }
    var last: LastReply?
    switch o["last_reply"] {
    case is NSNull:
      last = nil
    case let d as [String: Any]:
      guard Set(d.keys) == ["thread_id", "seq"], let id = d["thread_id"] as? String, ThreadIdRule.isValid(id),
        let seq = JSONValue.int(d["seq"]), seq >= 0
      else { return nil }
      last = LastReply(threadId: id, seq: seq)
    default:
      return nil
    }
    var viewing: String?
    switch o["viewing"] {
    case nil, is NSNull: viewing = nil
    case let id as String where ThreadIdRule.isValid(id): viewing = id
    default: return nil
    }
    var held: [HeldReply] = []
    switch o["held"] {
    case nil: break
    case let list as [Any]:
      // A bad entry drops that entry, never the frame (like a row). A thread is listed once with its newest seq.
      for e in list {
        guard let d = e as? [String: Any], Set(d.keys) == ["thread_id", "seq"], let id = d["thread_id"] as? String,
          ThreadIdRule.isValid(id), let seq = JSONValue.int(d["seq"]), seq >= 0
        else { continue }
        if let i = held.firstIndex(where: { $0.thread == id }) {
          held[i].seq = max(held[i].seq, seq)
        } else if held.count < maxRows {
          held.append(HeldReply(thread: id, seq: seq))
        }
      }
    default:
      return nil
    }
    var epoch: Int?
    switch o["replies_epoch"] {
    case nil, is NSNull: epoch = nil
    case let v?:
      guard let n = JSONValue.int(v), n >= 0 else { return nil }
      epoch = n
    }
    return CompanionFeed(
      link: link, macOnline: macOnline, busy: busy, needs: needs, working: working, queued: queued, onCall: onCall,
      unread: unread, failed: failed, rows: rows, lastReply: last, viewing: viewing, held: held, repliesEpoch: epoch)
  }

  private static func count(_ v: Any?) -> Int? {
    guard let n = JSONValue.int(v), (0...99_999).contains(n) else { return nil }
    return n
  }
}

/// `companion_reply`: the page's answer to a click, plain text of at most 500 characters or nil.
public struct CompanionReply: Equatable, Sendable {
  public var req: String
  public var threadId: String
  public var text: String?
  public var truncated: Bool

  public static let maxText = 500

  public init(req: String, threadId: String, text: String?, truncated: Bool) {
    self.req = req
    self.threadId = threadId
    self.text = text
    self.truncated = truncated
  }

  static func decode(_ o: [String: Any]) -> CompanionReply? {
    guard Set(o.keys) == ["type", "req", "thread_id", "text", "truncated"],
      let req = o["req"] as? String, CompanionReq.isValid(req),
      let id = o["thread_id"] as? String, ThreadIdRule.isValid(id),
      let truncated = JSONValue.bool(o["truncated"])
    else { return nil }
    var text: String?
    switch o["text"] {
    case is NSNull: text = nil
    case let s as String:
      guard s.utf16.count <= maxText else { return nil }
      text = s
    default: return nil
    }
    return CompanionReply(req: req, threadId: id, text: text, truncated: truncated)
  }
}

/// A request id: `^[A-Za-z0-9_-]{1,32}$`.
public enum CompanionReq {
  public static func isValid(_ s: String) -> Bool {
    (1...32).contains(s.utf8.count)
      && s.utf8.allSatisfy { ($0 >= 48 && $0 <= 57) || ($0 >= 65 && $0 <= 90) || ($0 >= 97 && $0 <= 122) || $0 == 95 || $0 == 45 }
  }
}

/// Whether the feed is still believed. The page re-sends at least every 30 s, so 90 s of silence means a throttled or wedged
/// page, and the pet must not keep showing its last frame (the watchdog can't catch it: a stuck page still answers `1`).
/// Time is a monotonic clock that keeps counting through sleep; a wall-clock jump changes nothing.
public struct CompanionFeedGate: Sendable {
  public static let staleAfter: Duration = .seconds(90)
  public private(set) var feed: CompanionFeed?
  private var lastFrameAt: ContinuousClock.Instant?
  /// 90 s in the app; tests shorten it to prove the real timer path without waiting a minute and a half.
  public let limit: Duration

  public init(limit: Duration = CompanionFeedGate.staleAfter) { self.limit = limit }

  /// Stores a frame. True when the feed changed (an equal frame only refreshes the clock).
  @discardableResult
  public mutating func accept(_ f: CompanionFeed, at now: ContinuousClock.Instant) -> Bool {
    lastFrameAt = now
    guard feed != f else { return false }
    feed = f
    return true
  }

  /// Clears the feed. True when there was one.
  @discardableResult
  public mutating func clear() -> Bool {
    lastFrameAt = nil
    guard feed != nil else { return false }
    feed = nil
    return true
  }

  /// Clears it if no frame has come for `staleAfter`. True when it did.
  @discardableResult
  public mutating func expireIfStale(at now: ContinuousClock.Instant) -> Bool {
    guard feed != nil, let t = lastFrameAt, t.duration(to: now) >= limit else { return false }
    return clear()
  }

  /// How long until the feed goes stale, or nil with no feed. The caller arms one timer with it.
  public func untilStale(at now: ContinuousClock.Instant) -> Duration? {
    guard feed != nil, let t = lastFrameAt else { return nil }
    return max(.zero, limit - t.duration(to: now))
  }
}

/// One last-reply request at a time. A new click replaces the old request; an answer that is not for the current request
/// (a late answer to an older click, another thread, another request id) is dropped and never shown.
public struct LastReplyTracker: Sendable {
  public enum Outcome: Equatable, Sendable {
    case text(String, truncated: Bool)
    /// The page answered: there is no text to show (nothing loaded, or the message has none).
    case empty
    /// No answer within the time limit.
    case timedOut
    /// The page could not be asked, or went away (reload, sign-out, a refusal). The caller shows "Open in Talos".
    case unavailable
    /// A newer click replaced this request.
    case superseded
  }
  public static let timeout: Duration = .seconds(3)

  public private(set) var current: (req: String, thread: String)?
  private var counter = 0

  public init() {}

  /// Starts a request. The previous one, if any, is returned so the caller can end it as `.superseded`.
  public mutating func begin(thread: String) -> (req: String, superseded: String?) {
    counter += 1
    let old = current?.req
    let req = "r\(counter)"
    current = (req, thread)
    return (req, old)
  }

  /// The outcome for an answer, or nil when it is not for the current request (drop it).
  public mutating func accept(_ r: CompanionReply) -> Outcome? {
    guard let c = current, c.req == r.req, c.thread == r.threadId else { return nil }
    current = nil
    if let t = r.text, !t.isEmpty { return .text(t, truncated: r.truncated) }
    return .empty
  }

  /// True when `req` was still current and is now over.
  public mutating func expire(req: String) -> Bool {
    guard current?.req == req else { return false }
    current = nil
    return true
  }

  /// Ends whatever is pending. Returns its request id.
  @discardableResult
  public mutating func cancel() -> String? {
    defer { current = nil }
    return current?.req
  }
}
