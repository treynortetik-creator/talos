import Foundation

/// `$TALOS_APP_HOME/main-restart-check.json`: the Mac app's answer to "would Main come back after a restart?" (docs/bridge.md,
/// `MainRestartCheckFile` in packages/protocol/src/main-restart.ts). Only this app can tell, because only it reads the launch seal.
/// The bridge's `restart_main` reads the file as advice; the app still decides when it reads a request.
///
/// `decide` is pure: the supervisor reads the inputs (SupervisorRestartCheck.swift) and writes what this says. It does not hold a second
/// copy of any rule. The development-channels answer is `AutoConfirmGuard.decide` itself, asked about the best screen a cold start could
/// show; the gap is `AgentRecovery.isTooSoon`; the seal is `LaunchSeal.isConfirmed`; the budget is the cold-start `CrashLoop`.
///
/// What cannot be known before the start, so a yes here can still end at Needs you (the guard checks these on the real screen):
///  - the screen itself: that it is the warning at all (`noDialog`), one title and one `Channels:` line (`ambiguousDialog`), the channels it
///    SHOWS (only the argv's are known now), the cursor on the right row (`wrongHighlight`), and the fresh read before the Enter
///    (`screenChanged`);
///  - the 60 s window (`outsideWindow`): taken as a start that shows its warning at once;
///  - `alreadyConfirmedThisStart`: always 0 for a start not made yet;
///  - typing and the budget at the moment of the warning, seconds after this check (they are read now);
///  - every other dialog (folder trust, MCP consent, the bypass notice, an expired login): none is ever answered, and none can be seen
///    before the pane draws it. The takeover check's `claude agents` listing is not run either (it is a subprocess every 5 s); a start
///    already Blocked by it counts.
public enum MainRestartCheck {
  /// `MAIN_RESTART_CHECK_FILE`.
  public static let fileName = "main-restart-check.json"
  /// `MAIN_RESTART_CHECK_WRITE_MS`, in seconds: the supervisor heartbeat.
  public static let writeEvery: Double = 5
  /// `MAIN_RESTART_CHECK_STALE_MS`, in seconds: the reader's limit (three missed writes). The app never reads its own file's age.
  public static let staleAfter: Double = 15
  /// `MAIN_RESTART_CHECK_MAX_BYTES`: a bigger file is not read by the bridge, so it is never written.
  public static let maxBytes = 4096
  /// `last.detail`, in characters: a dialog's label or a reason.
  public static let detailMax = 80

  /// `MAIN_RESTART_REASONS`, in the same order (the order reasons are written in).
  public enum Reason: String, CaseIterable, Equatable, Sendable {
    case launchChanged = "launch_changed"
    case claudePathChanged = "claude_path_changed"
    case autoConfirmOff = "auto_confirm_off"
    case budgetSpent = "budget_spent"
    case someoneTyping = "someone_typing"
    case takeoverHeld = "takeover_held"
    case ownerStopped = "owner_stopped"
    case tooSoon = "too_soon"
    /// desktop.json's saved conversation id is not a UUID: the start refuses it (`launchLocked`), so a restart would leave Main stopped.
    case sessionIdInvalid = "session_id_invalid"
    /// Written only by the Linux supervisor (its cap on restarts acted on per rolling hour); the Mac reads it, never writes it.
    case restartLimit = "restart_limit"
    case unknown
  }

  /// The would-be launch against the sealed one.
  public enum Seal: Equatable, Sendable {
    case confirmed
    /// `launchParts`' `program` differs from the sealed one.
    case programChanged
    /// Anything else: another folder, flag or env var, none sealed yet, or a MAC that does not verify.
    case launchChanged
    /// The fingerprint and its pieces are the sealed ones and a MAC is stored, but no key can be read to check it: not knowable.
    case keyUnreadable
  }

  /// `LaunchSeal.isConfirmed` with the inputs a cold start would use (`launchLocked`: `launchFingerprint`/`launchParts` of the resolved
  /// claude), and, when it says no, which piece. The key is asked about only when nothing else explains the no.
  /// `args`: the flags the start passes when they are not the saved ones (the channels flag added). A launch confirmed before that flag was
  /// added is still confirmed (the start re-seals it once, `Supervisor.migrateChannelsFlagSeal`).
  public static func seal(_ c: DesktopConfig, resolvedClaude: String, trust: LaunchTrust, args: [String]? = nil) -> Seal {
    let fp = c.launchFingerprint(resolvedClaude: resolvedClaude, args: args)
    let parts = c.launchParts(resolvedClaude: resolvedClaude, args: args)
    if LaunchSeal.isConfirmed(c, fingerprint: fp, parts: parts, trust: trust) { return .confirmed }
    if let args, args != c.args,
      LaunchSeal.isConfirmed(
        c, fingerprint: c.launchFingerprint(resolvedClaude: resolvedClaude), parts: c.launchParts(resolvedClaude: resolvedClaude), trust: trust)
    {
      return .confirmed
    }
    if DesktopConfig.changedPieces(confirmed: c.confirmedLaunchParts, now: parts).contains("program") { return .programChanged }
    if c.confirmedLaunch == fp, c.confirmedLaunchMac != nil, c.confirmedLaunchParts == (parts.isEmpty ? nil : parts),
      trust.mac("talos-restart-check/key-probe", createKey: false) == nil
    {
      return .keyUnreadable
    }
    return .launchChanged
  }

  public struct Inputs: Equatable, Sendable {
    /// desktop.json read when the supervisor was made. False: nothing starts (`refusesForUnreadableConfig`), and nothing is known.
    public var configReadable: Bool
    /// `resolveClaude`'s answer for the launch env; nil = a start fails with "claude was not found".
    public var claudeFound: Bool
    public var folderExists: Bool
    /// `session.id` is none or a UUID (`ResumeRewrite.isUUID`, the start's own check). Anything else: the start refuses it.
    public var sessionIdValid: Bool
    /// The launch passes `--dangerously-load-development-channels` (`launchLocked`'s `expects`): only then is there a warning to answer.
    public var expectsDevDialog: Bool
    // The guard's inputs that are known before the start, as `devDialogInputs` builds them.
    public var autoConfirm: Bool
    public var isMain: Bool
    public var launchedChannels: [String]
    public var seal: Seal
    /// `enabled && clientsMayBeTyping()`, as the guard is given it.
    public var clientsMayBeTyping: Bool
    /// The cold starts' budget (`coldLoop`): a request's restart is a cold start.
    public var coldLoop: CrashLoop
    /// The clock `coldLoop` counts on (the supervisor's monotonic clock).
    public var now: Double
    // The request's own rules (`AgentRecovery.decide`) and the start's.
    /// The last start was stopped by the takeover check (`.blocked`).
    public var takeoverHeld: Bool
    public var ownerStopped: Bool
    /// Awake seconds since a request was last acted on; nil = none.
    public var sinceLastRequest: Double?

    public init(
      configReadable: Bool = true, claudeFound: Bool = true, folderExists: Bool = true, sessionIdValid: Bool = true,
      expectsDevDialog: Bool = true,
      autoConfirm: Bool = true, isMain: Bool = true, launchedChannels: [String] = [AutoConfirmGuard.talosChannel],
      seal: Seal = .confirmed, clientsMayBeTyping: Bool = false, coldLoop: CrashLoop = CrashLoop(confirmCap: 10), now: Double = 0,
      takeoverHeld: Bool = false, ownerStopped: Bool = false, sinceLastRequest: Double? = nil
    ) {
      self.configReadable = configReadable
      self.claudeFound = claudeFound
      self.folderExists = folderExists
      self.sessionIdValid = sessionIdValid
      self.expectsDevDialog = expectsDevDialog
      self.autoConfirm = autoConfirm
      self.isMain = isMain
      self.launchedChannels = launchedChannels
      self.seal = seal
      self.clientsMayBeTyping = clientsMayBeTyping
      self.coldLoop = coldLoop
      self.now = now
      self.takeoverHeld = takeoverHeld
      self.ownerStopped = ownerStopped
      self.sinceLastRequest = sinceLastRequest
    }
  }

  public struct Verdict: Equatable, Sendable {
    public var willReturn: Bool
    /// Empty when `willReturn`; else at least one, each once, in `Reason.allCases` order.
    public var reasons: [Reason]
    public init(willReturn: Bool, reasons: [Reason]) {
      self.willReturn = willReturn
      self.reasons = reasons
    }
  }

  /// The best screen a cold start could show: the whole warning, Talos's one channel, the cursor on "I am using this for local development".
  public static var bestWarning: DialogMatcher.Screen {
    .devChannels(
      DialogMatcher.DevChannels(
        channels: [AutoConfirmGuard.talosChannel], highlighted: DialogMatcher.Strings.devConfirm, titleCount: 1, channelLineCount: 1))
  }

  /// The guard's inputs for a start made now that shows `bestWarning` at once.
  public static func guardInputs(_ i: Inputs) -> AutoConfirmGuard.Inputs {
    AutoConfirmGuard.Inputs(
      enabled: i.autoConfirm, isMain: i.isMain, launchedChannels: i.launchedChannels, screen: bestWarning,
      launchChanged: i.seal != .confirmed, secondsSinceSpawn: 0, confirmsThisStart: 0, clientsMayBeTyping: i.clientsMayBeTyping,
      loop: i.coldLoop, now: i.now)
  }

  /// The guard inputs with everything at its best, so one real input at a time shows which of them refuses.
  static func idealGuard(_ i: Inputs) -> AutoConfirmGuard.Inputs {
    var g = guardInputs(i)
    g.enabled = true
    g.isMain = true
    g.launchedChannels = [AutoConfirmGuard.talosChannel]
    g.launchChanged = false
    g.clientsMayBeTyping = false
    g.loop = CrashLoop(confirmWindow: i.coldLoop.confirmWindow, confirmCap: max(1, i.coldLoop.confirmCap))
    return g
  }

  static func reason(for refusal: AutoConfirmGuard.Refusal, seal: Seal) -> Reason {
    switch refusal {
    case .disabled: return .autoConfirmOff
    case .launchChanged:
      switch seal {
      case .programChanged: return .claudePathChanged
      case .keyUnreadable: return .unknown
      case .confirmed, .launchChanged: return .launchChanged
      }
    // the channels are part of the launch (its flags): a launch passing anything but Talos's one channel is not one the warning answers
    case .channelsMismatch: return .launchChanged
    case .clientsMayBeTyping: return .someoneTyping
    case .rateLimited: return .budgetSpent
    case .notMain, .noDialog, .ambiguousDialog, .wrongHighlight, .alreadyConfirmedThisStart, .outsideWindow, .screenChanged: return .unknown
    }
  }

  public static func decide(_ i: Inputs) -> Verdict {
    guard i.configReadable else { return Verdict(willReturn: false, reasons: [.unknown]) }
    var found = Set<Reason>()
    if i.ownerStopped { found.insert(.ownerStopped) }
    if AgentRecovery.isTooSoon(sinceLastRequest: i.sinceLastRequest) { found.insert(.tooSoon) }
    if i.takeoverHeld { found.insert(.takeoverHeld) }
    // no claude where the launch looks for it: the start fails, which is the program not being the confirmed one
    if !i.claudeFound { found.insert(.claudePathChanged) }
    if !i.folderExists { found.insert(.unknown) }
    if !i.sessionIdValid { found.insert(.sessionIdInvalid) }
    if i.expectsDevDialog, i.claudeFound {
      // Each known input alone, through the guard itself (so every reason is the guard's own), then all of them together: the guard's
      // answer on the real inputs is the one that counts, and a refusal none of the single looks explained still says no.
      let ideal = idealGuard(i)
      let real = guardInputs(i)
      let one: [(inout AutoConfirmGuard.Inputs) -> Void] = [
        { $0.enabled = real.enabled }, { $0.isMain = real.isMain }, { $0.launchedChannels = real.launchedChannels },
        { $0.launchChanged = real.launchChanged }, { $0.clientsMayBeTyping = real.clientsMayBeTyping }, { $0.loop = real.loop },
      ]
      var explained = false
      for set in one {
        var g = ideal
        set(&g)
        if case .refuse(let why) = AutoConfirmGuard.decide(g) {
          found.insert(reason(for: why, seal: i.seal))
          explained = true
        }
      }
      if case .refuse(let why) = AutoConfirmGuard.decide(real), !explained { found.insert(reason(for: why, seal: i.seal)) }
    }
    let reasons = Reason.allCases.filter(found.contains)
    return Verdict(willReturn: reasons.isEmpty, reasons: reasons)
  }

  // MARK: what became of the last request

  public enum Outcome: String, Equatable, Sendable {
    case cameBack = "came_back"
    case stalled
    case refused
  }

  /// `last` in the file: the newest request this app acted on or refused, and what happened to it.
  public struct Last: Equatable, Sendable {
    public var controlId: String
    /// Unix seconds, when the outcome was recorded.
    public var at: Double
    public var outcome: Outcome
    /// A stall: the dialog's label (`DialogMatcher.Screen.label`) or what held the start. A refusal: the `Reason` raw value.
    public var detail: String?

    public init(controlId: String, at: Double, outcome: Outcome, detail: String? = nil) {
      self.controlId = controlId
      self.at = at
      self.outcome = outcome
      self.detail = detail.map { String($0.prefix(MainRestartCheck.detailMax)) }
    }

    var json: [String: Any] {
      var o: [String: Any] = ["control_id": controlId, "at": ISOTime.string(at), "outcome": outcome.rawValue]
      if let detail { o["detail"] = detail }
      return o
    }

    /// The `last` of a file this app wrote before (a relaunch keeps it). Strict: anything off is nil, never a guess.
    public static func parse(_ data: Data?) -> Last? {
      guard let data, data.count <= MainRestartCheck.maxBytes,
        let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], let l = o["last"] as? [String: Any],
        let id = l["control_id"] as? String, AgentRequest.isValidId(id), let atText = l["at"] as? String,
        let at = ISOTime.parse(atText), let raw = l["outcome"] as? String, let outcome = Outcome(rawValue: raw)
      else { return nil }
      let detail = l["detail"] as? String
      if l["detail"] != nil, detail == nil { return nil }
      if let detail, detail.count > MainRestartCheck.detailMax || !isPlain(detail) { return nil }
      return Last(controlId: id, at: at, outcome: outcome, detail: detail)
    }

    /// Every `detail` this app writes itself: the dialog labels, the stall labels and the reason names.
    public static let ownLabels: Set<String> = {
      let screens: [DialogMatcher.Screen] = [
        MainRestartCheck.bestWarning, .trust, .mcpConsent, .bypassDisclaimer, .loginExpired, .computerUsePermissions,
        .usageLimit(.init()), .resumeMissing, .unknownSelection, .none,
      ]
      return Set(screens.map(\.label) + [stallBlocked, stallNotStarted, stallNothingKnown] + Reason.allCases.map(\.rawValue))
    }()

    /// A `last` read back from the file: its `detail` only when it is one of `ownLabels`.
    public static func ownLabelsOnly(_ l: Last) -> Last {
      var l = l
      if let d = l.detail, !ownLabels.contains(d) { l.detail = nil }
      return l
    }

    /// Printable ASCII only: a label or a reason name is never anything else.
    static func isPlain(_ s: String) -> Bool { s.utf8.allSatisfy { $0 >= 0x20 && $0 < 0x7f } }
  }

  // A stall's `detail`: a dialog's own label (`DialogMatcher.Screen.label`), or one of these for a start that is held without one.
  /// The development-channels warning held for the owner (the guard refused it).
  public static var devWarningLabel: String { bestWarning.label }
  /// The start was Blocked by the takeover check (another session holds the channels).
  public static let stallBlocked = "takeover check"
  /// The start could not be made at all (no claude, no folder, an unreadable desktop.json, a resume that failed).
  public static let stallNotStarted = "could not start"
  /// Started, but after the start wait nothing Talos knows is on screen.
  public static let stallNothingKnown = "no screen Talos knows"

  /// The one phone line for a restart a request asked for that is held (a dialog, the takeover check, a start that could not be made, a
  /// screen Talos does not know). `label` is one of the fixed labels above, never screen text, so the Mac may post it as its own row.
  public static func stallPhoneLine(_ label: String) -> String {
    if label == UsageLimitScreen.kind { return UsageLimitScreen.stallLine }
    if DialogMatcher.Screen.answerless(label: label) {
      return "Main restarted on request and is showing the \(label) dialog at your Mac. To close it, press Esc in Main's pane; Esc is the only key to press there."
    }
    return "Main restarted on request and is waiting at your Mac (\(label)). Look at the Mac; Talos does not answer that one."
  }

  /// The phone line for a refused request. `reason` is a `Reason` raw value (or AgentRecovery's `owner_stopped`/`too_soon`, the same names).
  public static func refusedPhoneLine(_ reason: String) -> String {
    "Main was not restarted: \(reasonSentence(reason))"
  }

  /// The same line for a request with no proof and no thread: a session's, or the phone's own button through a bridge older than the
  /// owner's proof (until that bridge restarts). It says what to do in the second case. Fixed words around the reason's own sentence.
  public static func refusedUnprovedPhoneLine(_ reason: String) -> String {
    refusedPhoneLine(reason) + " If you tapped Restart on your phone, restart Main from the Mac's menu."
  }

  /// The line for the owner's own request that this Mac does not take as the owner's word (`RestartProofCheck.Unaccepted`): it went the
  /// agent's way. Fixed words; a refusal adds its own sentence after it.
  public static func clockPhoneLine(_ why: RestartProofCheck.Unaccepted) -> String {
    switch why {
    case .skew:
      return "Your phone's restart request was signed at a time this Mac does not accept (check the phone's clock); it was treated as a session's."
    case .beforeLaunch: return "Your phone's restart request was signed before this app started; it was treated as a session's."
    case .beforeMark:
      return "Your phone's restart request was signed earlier than one this Mac already accepted (check the phone's clock); it was treated as a session's."
    case .unknownForm:
      return "Your phone's restart request uses a form this version of the Mac app does not know (update the Mac app); it was treated as a session's."
    }
  }

  /// The phone line for a request whose owner's proof did not verify. Fixed: nothing from the file is in it.
  public static let proofBadPhoneLine = "Main was not restarted: a restart request that claimed to be yours did not verify."

  /// The phone line when the app acts on a restart a session asked for. `byThread` is a checked thread id (nil: Main's own session);
  /// `why` is the session's own text, already made plain (`AgentRequest.plainText`): this line never goes out as the Mac's own row.
  /// Who is never a bare name (a forged `by_thread: "owner"` must not read as "asked by the owner"): always "a session", with the thread
  /// id quoted only when this Mac knows a thread by that id (`known`, from config.json and workers.json).
  /// `noProof`: the request carried no owner's proof, so with no thread it may be the owner's own phone through a bridge that has not
  /// restarted since the proof came in, and the line says so.
  public static func restartingPhoneLine(byThread: String?, known: Bool, why: String?, noProof: Bool = false) -> String {
    let who: String
    switch byThread {
    case nil where noProof: who = "a session, or by your phone through a bridge that has not restarted yet"
    case nil: who = "a session (no thread named)"
    case let t? where known: who = "a session in thread \u{201C}\(t)\u{201D}"
    case _?: who = "a session (thread not known)"
    }
    return "Main is restarting, asked by \(who)" + (why.map { ": \($0)" } ?? ".")
  }

  /// The thread ids this Mac knows: `threads[].id` in the bridge's config.json and the keys of workers.json's `threads`. Unreadable
  /// files give none (so no id is vouched for).
  public static func knownThreadIds(configJson: Data?, workersJson: Data?) -> Set<String> {
    var ids = Set<String>()
    if let d = configJson, let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any], let ts = o["threads"] as? [[String: Any]] {
      for t in ts { if let id = t["id"] as? String { ids.insert(id) } }
    }
    if let d = workersJson, let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any], let ts = o["threads"] as? [String: Any] {
      ids.formUnion(ts.keys)
    }
    return ids
  }

  /// One sentence per reason, the Mac's own words.
  public static func reasonSentence(_ raw: String) -> String {
    switch Reason(rawValue: raw) {
    case .launchChanged?: return "the way Main starts has changed since you confirmed it at the Mac, so it would wait at its startup warning."
    case .claudePathChanged?: return "the claude program is not the one you confirmed at the Mac, so Main would wait at its startup warning."
    case .autoConfirmOff?: return "answering the startup warning automatically is off, so Main would wait at it."
    case .budgetSpent?: return "the Mac has used up its automatic restarts for now, so Main would wait at its startup warning."
    case .someoneTyping?: return "someone is typing in Main's window on the Mac."
    case .takeoverHeld?: return "another agent is already using this account."
    case .ownerStopped?: return "you stopped Main at the Mac, and that stands until you start it again."
    case .tooSoon?: return "Main was restarted less than 2 minutes ago."
    case .sessionIdInvalid?: return "the saved conversation id in desktop.json is not a session id, so Main would not start."
    case .restartLimit?: return "Main was already restarted on request 3 times in the last hour; the limit stops a session restarting it over and over."
    case .unknown?, nil: return "the Mac could not tell whether Main would come back."
    }
  }

  // MARK: how often the owner hears about requests

  /// The three phone lines about restart requests. A process that writes agent-request.json itself can make one request a second
  /// (a fresh control_id every tick), so none of them may follow requests one for one.
  public enum PhoneLine: String, CaseIterable, Sendable {
    /// "Main is restarting, asked by ...": only for a session's request the app acts on.
    case restarting
    /// "Main was not restarted: ...": any refused request.
    case refused
    /// "Main restarted on request and is waiting at your Mac (...)": the first hold of a restart a request began.
    case stalled
  }

  /// At most one line of each kind per this many seconds on the awake clock (the request gap's own clock and number).
  public static let phoneLineGap: Double = AgentRecovery.requestMinGap

  /// The bound, worst case, whatever writes the request file: each kind at most once per `phoneLineGap` (120 s), so at most 30 an
  /// hour of each and 90 an hour in all, and never more than ONE `talos-app post` child running for them: a line due while one runs is
  /// dropped, not queued. Every request is still recorded in `last` and in the audit log; only the phone line is spaced.
  public struct PhoneLines: Equatable, Sendable {
    var postedAt: [PhoneLine: Double] = [:]
    public private(set) var inFlight = false
    public init() {}

    /// Whether a line of `kind` may go out now; when it may, it is counted as posted and in flight until `finished()`.
    public mutating func take(_ kind: PhoneLine, awake: Double) -> Bool {
      guard !inFlight else { return false }
      if let t = postedAt[kind], awake - t < MainRestartCheck.phoneLineGap { return false }
      postedAt[kind] = awake
      inFlight = true
      return true
    }

    public mutating func finished() { inFlight = false }
  }

  /// The file's bytes. `at` is unix seconds.
  /// `needsYou`: the dialog Main sits on and since when (unix seconds), as `needs_you` (the protocol's WorkerNeedsYou shape).
  /// `resetsAt` (unix seconds): `needs_you.resets_at`, written only when the dialog is the usage-limit screen.
  public static func encode(
    at: Double, verdict: Verdict, last: Last?, needsYou: (kind: String, since: Double)? = nil, resetsAt: Double? = nil
  ) -> Data {
    var o: [String: Any] = [
      "v": 1, "at": ISOTime.string(at), "will_return": verdict.willReturn, "reasons": verdict.reasons.map(\.rawValue),
    ]
    if let last { o["last"] = last.json }
    if let n = needsYou {
      let v = WorkersFile.NeedsYou(kind: n.kind, since: ISOTime.string(n.since))
      var ny = ["kind": v.kind, "since": v.since]
      if n.kind == UsageLimitScreen.kind, let r = resetsAt { ny["resets_at"] = ISOTime.string(r) }
      o["needs_you"] = ny
    }
    let d = (try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys])) ?? Data()
    guard d.count > maxBytes, last?.detail != nil, var l = last else { return d }
    l.detail = nil  // never reached with a capped detail; a file the reader would refuse is never written
    return encode(at: at, verdict: verdict, last: l, needsYou: needsYou, resetsAt: resetsAt)
  }

  /// What the app writes when it cannot work the answer out.
  public static let unknownVerdict = Verdict(willReturn: false, reasons: [.unknown])
}
