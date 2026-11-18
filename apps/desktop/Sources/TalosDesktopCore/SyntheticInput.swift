import Foundation

/// Which input is the owner's own hand, and which is not. An agent may control Talos like any allowed app (`ScreenCore`), with one
/// exception that has no switch: a click or a key an agent sent never answers an approval card or a permission prompt (Approve, Deny,
/// Always allow, a dialog's options, Kill, Revise, the popup's buttons, a sheet or alert), and never reaches a terminal view in Talos
/// (the agent's pane, the owner's shell, the sign-in pane): only the owner's mouse, trackpad and keyboard do.
///
/// How it is kept (docs/SECURITY.md "An agent in Talos"):
/// - Every event Talos posts for an agent carries a token in its CGEvent user data (`ScreenInputBackend.post(_:token:)`), and the
///   system stamps it with this process's pid. An event counts as the owner's only when it has none of that: a CGEvent from the
///   hardware state, source pid 0, user data 0, and no event of ours still awaiting its answer (`Flight`). Anything else, or an event
///   that cannot be read, is synthetic.
/// - The Talos window tells its page the origin of each mouse and key event before it delivers the event (`ProtectedInputScript`);
///   native windows that answer prompts and every terminal view drop a synthetic event outright.
/// - Each token is answered: "handled" (the page, or the window that took it, says the event was dealt with) or "dropped". The
///   screen tool waits for the answer of its own tokens and says `protected_prompt` for a drop, `delivery_unverified` when no answer
///   came in time. It never says sent on a guess.
public enum SyntheticInput {
  public enum Origin: Sendable, Equatable { case human, synthetic }

  /// `CGEventSourceStateID.hidSystemState`: events from the mouse, trackpad or keyboard.
  public static let hidSystemStateId: Int64 = 1

  /// The origin of one event. Pure: the CGEvent's fields, nil when the event has no CGEvent (a hardware event always has one, so its
  /// absence is not proof of a person). `userData` is the token Talos puts on its own posts (0 on hardware events).
  public static func classify(
    sourcePid: Int64?, sourceStateId: Int64?, userData: Int64? = 0, postedByThisProcessNow: Bool
  ) -> Origin {
    guard let sourcePid, let sourceStateId, let userData, !postedByThisProcessNow else { return .synthetic }
    return sourcePid == 0 && sourceStateId == hidSystemStateId && userData == 0 ? .human : .synthetic
  }

  /// How a request's own events were dealt with.
  public enum Settled: Sendable, Equatable {
    case handled
    /// An event hit an approval or permission button, or a terminal, and was dropped.
    case dropped
    /// No answer in time: the events may or may not have landed.
    case unverified
  }

  /// The events this process posts for an agent, by token, and what became of each. Shared by the posting side (`ScreenCore`) and every
  /// window that receives or drops (one instance per process; a test makes its own). Tokens are unique, so two callers at once never
  /// read each other's answers.
  public final class Flight: @unchecked Sendable {
    private let cond = NSCondition()
    private var next: Int64 = 0
    private var posting = 0
    private var expected: [Int64: Int] = [:]  // token -> answers still owed
    private var dropped = Set<Int64>()
    private var strays = 0
    /// This process's pid: an event aimed at an app with it is aimed at Talos.
    public let ownPid: Int32

    public init(ownPid: Int32 = getpid()) { self.ownPid = ownPid }

    /// A new token (never 0); an event is about to be posted.
    public func begin() -> Int64 {
      cond.lock()
      defer { cond.unlock() }
      next += 1
      posting += 1
      return next
    }

    /// The post is done.
    public func end() {
      cond.lock()
      posting = max(0, posting - 1)
      cond.unlock()
    }

    /// `answers` events carrying `token` will each be answered by `handled` (or the token by `drop`). Called before the post.
    public func expect(_ token: Int64, answers: Int) {
      cond.lock()
      expected[token] = max(1, answers)
      cond.unlock()
    }

    /// One answer: an event of `token` was dealt with. Unknown tokens (already forgotten) are ignored.
    public func handled(_ token: Int64) {
      cond.lock()
      if let n = expected[token], n > 0 { expected[token] = n - 1 }
      cond.broadcast()
      cond.unlock()
    }

    /// An event of `token` was dropped (a protected button, a terminal). Token 0: not one of ours (an Accessibility press, say); counted
    /// only in `strays`.
    public func drop(_ token: Int64 = 0) {
      cond.lock()
      if token != 0, expected[token] != nil { dropped.insert(token) } else { strays += 1 }
      cond.broadcast()
      cond.unlock()
    }

    public var strayDrops: Int {
      cond.lock()
      defer { cond.unlock() }
      return strays
    }

    /// Waits until each token is answered, one is dropped, or `timeout` seconds pass.
    public func wait(_ tokens: [Int64], timeout: Double) -> Settled {
      let end = Date(timeIntervalSinceNow: max(0, timeout))
      cond.lock()
      defer { cond.unlock() }
      while true {
        if tokens.contains(where: { dropped.contains($0) }) { return .dropped }
        if tokens.allSatisfy({ (expected[$0] ?? 0) == 0 }) { return .handled }
        if !cond.wait(until: end) { return tokens.contains(where: { dropped.contains($0) }) ? .dropped : .unverified }
      }
    }

    public func forget(_ tokens: [Int64]) {
      cond.lock()
      for t in tokens {
        expected[t] = nil
        dropped.remove(t)
      }
      cond.unlock()
    }

    /// An event of ours may still be on its way to a window: one is being posted, or one has not been answered yet. It lasts until
    /// the answer or the request's own timeout, never a fixed span.
    public var active: Bool {
      cond.lock()
      defer { cond.unlock() }
      return posting > 0 || expected.values.contains { $0 > 0 }
    }
  }

  /// The one in use by the app.
  public static let flight = Flight()
}

/// Windows no agent screenshot may show (a sign-in setup link is on one). Their ids are the window server's (`NSWindow.windowNumber`).
public enum ScreenSecretWindows {
  private static let ids = LockedValue<Set<UInt32>>([])
  public static var current: Set<UInt32> { ids.value }
  public static func set(_ id: UInt32, hidden: Bool) {
    var s = ids.value
    if hidden { s.insert(id) } else { s.remove(id) }
    ids.value = s
  }
}
