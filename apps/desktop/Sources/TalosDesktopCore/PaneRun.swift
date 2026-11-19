import CryptoKit
import Foundation

/// Running a script the owner tapped Run on in the owner's own shell pane (docs/TERMINAL-PANE.md, "One path to the shell"). The pure
/// parts: what a request and a witness look like, the witness table, the text that goes to the shell, and the monotonic clock the
/// rules are read on. The AppKit side (the window that sees the owner's click, the pane that holds the pty) is in TalosDesktop.
public enum PaneRun {
  /// How recent the owner's real click or key in the Talos window must be when the page vouches for a Run. Mirrors
  /// `RUN_PANE_CLICK_MS` (packages/protocol/src/run.ts, 2000); `ShellPaneReachTests` fails if the two drift.
  public static let clickSeconds: Double = 2.0
  /// How long a witness waits for its Run to arrive from the bridge (relay, bridge, socket). Past this it is gone.
  public static let witnessSeconds: Double = 30
  /// The most witnesses held at once. A full table refuses the new witness (it never drops one that is waiting).
  public static let maxWitnesses = 16
  /// How many spent message ids are remembered, so a witness that is sent again for a Run that already ran is refused.
  public static let maxSpent = 64
  /// How long a Run that arrives before its witness waits for it (the page's message and the bridge's race on two roads).
  public static let witnessWaitSeconds: Double = 1.5
  /// A shell counts as started when its process is running and has had this long to set up its terminal: typed-ahead input to a
  /// shell still reading its profile is the one place a script could be lost.
  public static let shellStartSeconds: Double = 0.3
  /// `RUN_SCRIPT_MAX_CHARS`: the longest script a Run can carry at all.
  public static let maxScriptChars = 4000
  /// How long a Run waits for its thread's pane to be on screen with a started shell that is at its line editor: the page opens the pane
  /// as it sends the Run, and a new shell may still be reading a slow profile. Past it the Run is refused (`not_started`, or `pane_busy`).
  public static let paneWaitSeconds: Double = 5
  /// After the Ctrl+C that discards whatever is on the shell's line, how long the shell has to take it and come back to its line editor
  /// (a prompt that runs a slow hook, a synchronous git status, takes a while).
  public static let clearWaitSeconds: Double = 3
  /// The whole of one Run in the app, from the moment it is taken to the last byte it may write: the witness wait, the pane wait and the
  /// clear wait fit inside it. A Run that is not done by then writes nothing more and is refused `pane_busy`. The bridge waits for this
  /// plus a margin (`PANE_RUN_APP_BUDGET_MS` in apps/bridge/src/pane-run.ts; a drift test holds them equal), so it never says "nothing
  /// was run" about a Run that is still going.
  public static let totalBudgetSeconds: Double = 10
  /// The shell's output must have been quiet this long, with the line editor back on, before the script is pasted.
  public static let promptQuietSeconds: Double = 0.05
  /// A mouse press this soon after the app became active or the Talos window became key is the click that brought it forward: not a Run.
  public static let activationSettleSeconds: Double = 0.5

  /// `^m_[0-9A-HJKMNP-TV-Z]{26}$`, the protocol's message id.
  public static func isMsgId(_ s: String) -> Bool {
    let u = Array(s.utf8)
    guard u.count == 28, u[0] == 109, u[1] == 95 else { return false }
    let ok = Set("0123456789ABCDEFGHJKMNPQRSTVWXYZ".utf8)
    return u[2...].allSatisfy { ok.contains($0) }
  }

  /// 64 lowercase hex characters.
  public static func isSha256Hex(_ s: String) -> Bool {
    let u = Array(s.utf8)
    return u.count == 64 && u.allSatisfy { ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 102) }
  }

  /// SHA-256 of the script's UTF-8 bytes exactly as received (no trim: a trailing line feed is part of it).
  public static func sha256(_ script: String) -> [UInt8] { Array(SHA256.hash(data: Data(script.utf8))) }

  /// The same, as the page writes it (lowercase hex).
  public static func sha256Hex(_ script: String) -> String { sha256(script).map { String(format: "%02x", $0) }.joined() }

  /// The 32 bytes of a 64-character lowercase hex digest, nil for anything else.
  public static func hexBytes(_ s: String) -> [UInt8]? {
    guard isSha256Hex(s) else { return nil }
    let u = Array(s.utf8)
    func nibble(_ c: UInt8) -> UInt8 { c <= 57 ? c - 48 : c - 87 }
    return stride(from: 0, to: 64, by: 2).map { nibble(u[$0]) << 4 | nibble(u[$0 + 1]) }
  }

  /// Why a script cannot go to the shell, or nil when it can. A Run's script is what the tap showed: printable text, line feeds and
  /// tabs, ending in a line feed (`runText`). Anything else is refused here again, whoever sent it: ESC and every other C0 control
  /// (U+0000-U+0008, U+000B-U+001F), DEL and every C1 control (U+007F-U+009F), so neither `ESC [ 201 ~` nor the 8-bit `U+009B 201 ~`
  /// can end a bracketed paste early; and look-alike or direction-changing characters.
  public static func scriptProblem(_ s: String) -> String? {
    if s.isEmpty || s.allSatisfy({ $0 == "\n" || $0 == "\t" || $0 == " " }) { return "the script is empty" }
    if s.unicodeScalars.count > maxScriptChars { return "the script is longer than \(maxScriptChars) characters" }
    if !s.hasSuffix("\n") { return "the script does not end with a line break" }
    for u in s.unicodeScalars where u != "\n" && u != "\t" {
      switch u.properties.generalCategory {
      case .control, .format, .lineSeparator, .paragraphSeparator, .privateUse, .unassigned, .surrogate:
        return "the script holds a character that is not plain text"
      default: break
      }
    }
    return nil
  }

  /// What goes to the shell: the script as one bracketed paste (`ESC[200~ … ESC[201~`, its one trailing line feed stripped), then exactly
  /// one Return. So no line of it runs before the whole script has arrived, a `for` or a heredoc is one unit, and a tab is a tab, not
  /// completion. The shell is only written to while its line editor has asked for this mode (`OwnerShellPane.runScript`), so the markers
  /// are never printed; there is no other way to send a script.
  public static func bytes(script: String) -> [UInt8] {
    let body = script.hasSuffix("\n") ? String(script.dropLast()) : script
    return [0x1b] + Array("[200~".utf8) + Array(body.utf8) + [0x1b] + Array("[201~".utf8) + [0x0d]
  }
}

/// How much a shell's terminal has printed lately, as a count and a time: no bytes, no text. The pane reads it to tell that the shell has
/// answered something (a Ctrl+C) and gone quiet. Written on the output thread, read on the main one.
public final class OutputPulse: @unchecked Sendable {
  private let lock = NSLock()
  private var n = 0
  private var last: Double = 0
  public init() {}
  public func tick(now: Double = Monotonic.now()) { lock.withLock { n += 1; last = now } }
  /// How many output batches so far, and when the last one came.
  public var state: (count: Int, lastAt: Double) { lock.withLock { (n, last) } }
}

/// A clock that does not jump with the wall clock and keeps counting while the Mac sleeps (`CLOCK_MONOTONIC` is the one that does on
/// macOS), so a click before a sleep is never "fresh" after it, and nobody's date change reaches the rules.
public enum Monotonic {
  public static func now() -> Double { Double(clock_gettime_nsec_np(CLOCK_MONOTONIC)) / 1e9 }
}

/// When the owner last did something only a person does in the Talos window: a real click's release, or a real Return or Space.
/// The window records it (one place, `WebNSWindow.sendEvent`) from the event's own origin; nothing else in the app can set it.
public struct HumanActivation: Sendable {
  private var last: Double?
  public init() {}
  public mutating func record(at now: Double) { last = now }
  /// Seconds since, or nil when it never happened. A clock reading from before the stamp (never, on a monotonic clock) is nil.
  public func age(now: Double) -> Double? {
    guard let last, now >= last else { return nil }
    return now - last
  }
  public func isFresh(now: Double, within seconds: Double = PaneRun.clickSeconds) -> Bool {
    guard let a = age(now: now) else { return false }
    return a <= seconds
  }
  /// Spends the stamp: true when it was fresh. One person's click or key vouches for at most one thing.
  public mutating func take(now: Double, within seconds: Double = PaneRun.clickSeconds) -> Bool {
    let fresh = isFresh(now: now, within: seconds)
    last = nil
    return fresh
  }
}

/// What the page said it was about to run, vouched for by the owner's own click (`run_witness`): which message, in which thread, and
/// the hash of the script. A pane Run is accepted only against one of these, once. Ids, threads and hashes are compared as bytes.
public struct RunWitnessBook: Sendable {
  public enum Outcome: Equatable, Sendable {
    case granted
    /// No witness for that message (never made, already used, or the table dropped it).
    case missing
    /// A witness for that message existed and was older than `PaneRun.witnessSeconds`. It is gone.
    case expired
    /// A witness for that message existed for another thread or another script. It is gone: a mismatch burns it.
    case otherThread
    case otherScript
  }

  public enum Recorded: Equatable, Sendable {
    case kept
    /// That message already has a witness waiting.
    case duplicate
    /// That message already ran: a witness for it is never taken again.
    case spent
    /// Sixteen witnesses are waiting; the new one is refused.
    case full
  }

  struct Entry: Sendable {
    let id: [UInt8]
    let thread: [UInt8]
    let sha: [UInt8]
    let at: Double
  }
  private(set) var entries: [Entry] = []
  private var spent: [[UInt8]] = []
  public init() {}

  public var count: Int { entries.count }

  /// Keeps a witness (the script hash as its 32 bytes).
  @discardableResult
  public mutating func record(id: String, thread: String, sha: [UInt8], at now: Double) -> Recorded {
    let idB = Array(id.utf8)
    entries.removeAll { now < $0.at || now - $0.at > PaneRun.witnessSeconds }
    if spent.contains(idB) { return .spent }
    if entries.contains(where: { $0.id == idB }) { return .duplicate }
    if entries.count >= PaneRun.maxWitnesses { return .full }
    entries.append(Entry(id: idB, thread: Array(thread.utf8), sha: sha, at: now))
    return .kept
  }

  /// Checks a Run against its witness and spends it. Check and spend are one step: two Runs for one witness never both pass, and a
  /// witness that does not match (or is too old) is gone too, so a wrong Run cannot be tried again with a right one.
  public mutating func consume(id: String, thread: String, sha: [UInt8], now: Double) -> Outcome {
    let idB = Array(id.utf8)
    guard let i = entries.firstIndex(where: { $0.id == idB }) else { return .missing }
    let e = entries.remove(at: i)
    spent.append(idB)
    if spent.count > PaneRun.maxSpent { spent.removeFirst(spent.count - PaneRun.maxSpent) }
    if now < e.at || now - e.at > PaneRun.witnessSeconds { return .expired }
    if e.thread != Array(thread.utf8) { return .otherThread }
    if e.sha != sha { return .otherScript }
    return .granted
  }
}

/// One `pane_run` request, as the bridge sends it on the Mac-local socket.
public struct PaneRunRequest: Equatable, Sendable {
  public let threadId: String
  public let script: String
  public let clientMsgId: String
  public init(threadId: String, script: String, clientMsgId: String) {
    self.threadId = threadId
    self.script = script
    self.clientMsgId = clientMsgId
  }

  /// nil + a reason for a request that does not have the shape: exactly these fields (and the socket's own `v`, `id`, `op`).
  public static func parse(_ o: [String: Any]) -> (request: PaneRunRequest?, problem: String?) {
    let known: Set<String> = ["v", "id", "op", "thread_id", "script", "client_msg_id"]
    guard Set(o.keys).isSubset(of: known) else { return (nil, "the request has a field this Talos does not know") }
    guard let t = o["thread_id"] as? String, ThreadIdRule.isValid(t) else { return (nil, "the request has no valid thread") }
    guard let id = o["client_msg_id"] as? String, PaneRun.isMsgId(id) else { return (nil, "the request has no valid message id") }
    guard let s = o["script"] as? String else { return (nil, "the request has no script") }
    // what the script holds is judged by the channel, after the witness: a refusal there is told to the page by this message's id
    return (PaneRunRequest(threadId: t, script: s, clientMsgId: id), nil)
  }
}

/// The answer to a `pane_run`: ok, or a code and the owner's sentence (the bridge puts it after "Run couldn't reach the terminal pane:").
public struct PaneRunAnswer: Equatable, Sendable {
  public let ok: Bool
  public let code: String
  public let text: String
  public static let done = PaneRunAnswer(ok: true, code: "ok", text: "")
  public static func no(_ code: String, _ text: String) -> PaneRunAnswer { PaneRunAnswer(ok: false, code: code, text: text) }

  /// The codes are the ones the page is told (`run_result.reason`): no_witness, expired, not_started, pane_busy. (app_closed is the
  /// bridge's own: it never reached the app.) The sentences are for the owner, after "Run couldn't reach the terminal pane:".
  public static let noWitness = no("no_witness", "your click in the Mac app didn't come with that Run")
  public static let mismatch = no("no_witness", "that Run isn't the script you clicked on")
  public static let witnessExpired = no("expired", "that Run came too long after your click")
  public static let noPane = no("not_started", "this thread's terminal pane isn't open. Open it, then tap Run again")
  public static let noShell = no("not_started", "this thread's terminal pane has no shell running yet")
  /// Not in the protocol's first list of reasons: the page is told `bad_script` (docs/TERMINAL-PANE.md).
  public static func badScript(_ why: String) -> PaneRunAnswer { no("bad_script", why) }
  public static let busy = no("pane_busy", "the shell is busy or not at its prompt. Wait for it, or open a new tab (+) and tap Run again")
  public var isNotStarted: Bool { code == "not_started" }

  public static func outcome(_ o: RunWitnessBook.Outcome) -> PaneRunAnswer? {
    switch o {
    case .granted: return nil
    case .missing: return noWitness
    case .expired: return witnessExpired
    case .otherThread, .otherScript: return mismatch
    }
  }
}
