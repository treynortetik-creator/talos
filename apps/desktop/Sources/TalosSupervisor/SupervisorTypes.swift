import Foundation
import TalosDesktopCore

// The supervisor's value types (options, timings, phases, status, events and the records it keeps for a launch and a clean-up)
// and two small helpers. The state machine itself is `Supervisor`.
extension Supervisor {
  public struct Timings: Sendable {
    public var tick: Double = 1
    public var backoff = Backoff()
    public var cleanupWait: Double = 10
    public var stopGrace: Double = 5
    public var noticeWait: Double = 15
    /// How long a start may stay in `.starting` (neither the dev-channel dialog nor the registration notice recognised on
    /// screen) before the owner is told. Far longer than a slow start needs; it only ends a wait that would never end.
    public var startWait: Double = 120
    public var dialogStall: Double = 60
    /// A prompt of the CLI's that Talos has no name for counts after its region of the screen has held still this long.
    public var promptSettle: Double = 5
    /// ... and while an attached client has not typed for this long (an owner-opened picker is not waiting on anybody).
    public var promptClientQuiet: Double = 30
    /// The dev-channels warning is answered only while no attached tmux client has typed for this long (or when the clients cannot be read: never).
    /// tmux reports a client's activity in whole seconds, so the quiet needed is up to a second longer than this.
    public var devDialogClientQuiet: Double = 5
    public var agentsPoll: Double = 10
    public var hangPolls: Int = 2
    public var restartWindow: Double = 900
    public var restartCap: Int = 5
    public var confirmWindow: Double = 3600
    public var confirmCap: Int = 3
    /// Auto-answers of the dev-channels warning on COLD starts (the owner's resets, the phone's restart, a launch change) allowed per
    /// `confirmWindow`. They do not spend `confirmCap`, which is the crash loop's: three resets in an hour must not make the fourth wait
    /// for a human, and must not turn one real crash into a "crash loop". Ten an hour still stops a runaway self-restart.
    public var coldConfirmCap: Int = 10
    public init() {}
  }

  public struct Options: Sendable {
    /// Session name (tmux session, audit tag). `agent` for the main session.
    public var name: String
    public var configPath: String
    public var home: String
    /// `$TALOS_APP_HOME`; nil = from the launch env, else `~/.config/talos/app`.
    public var talosAppHome: String?
    public var auditLogPath: String?
    /// The key store that seals `confirmed_launch`. The in-memory store unless the app hands over the Keychain one (the app's own start, `App.init`):
    /// nothing under test ever touches the Keychain.
    public var launchTrust: LaunchTrust = MemoryLaunchTrust()
    /// Run the takeover check (4.2) before every start. Option C workers keep it on too.
    public var takeoverCheck: Bool = true
    /// Process groups owned by sibling supervisors (Option C: main whitelists its workers' panes, OPTION-C-SPEC 4.4).
    public var siblingGroups: (@Sendable () -> Set<Int32>)?
    /// Unix milliseconds. A request's `ts` is wall-clock time, which the monotonic clock cannot be compared with; tests move this.
    public var wallClock: @Sendable () -> Double = { Date().timeIntervalSince1970 * 1000 }
    /// Seconds that stop while the Mac sleeps (CLOCK_UPTIME_RAW). `MonotonicClock` is CLOCK_MONOTONIC, which keeps counting through
    /// sleep on macOS, so it cannot tell awake time from time asleep. Tests move this.
    public var awake: @Sendable () -> Double = { Double(DispatchTime.now().uptimeNanoseconds) / 1e9 }
    /// Where the restore child and the phone post run: a thread of their own, never the shared dispatch pool, which gives no thread
    /// for as long as every core is held by a blocked one. The work reports back to the supervisor queue with `sync`. A test
    /// replaces this to see that both go through it.
    public var background: @Sendable (@escaping @Sendable () -> Void) -> Void = { work in Thread.detachNewThread(work) }
    public init(name: String, configPath: String, home: String, talosAppHome: String? = nil, auditLogPath: String? = nil) {
      self.name = name
      self.configPath = configPath
      self.home = home
      self.talosAppHome = talosAppHome
      self.auditLogPath = auditLogPath
    }
  }

  public enum StopReason: Equatable, Sendable {
    case user
    case crashLoop
    case resumeMissing(String)
    case noNotice
    case crashedNoAutoRestart
    case startFailed(String)
  }

  public enum Phase: Equatable, Sendable {
    case idle
    case blocked([TakeoverCheck.Blocker])
    /// Launched; the dev-channel dialog or the registration notice is pending.
    case starting
    case running
    /// After a crash: the dead child's group is being cleared before the restart (4.3 step 1a).
    case cleaningUp
    case waitingToRestart
    case stopping
    case stopped(StopReason)
  }

  public enum NeedsYou: Equatable, Sendable {
    /// A dialog Talos never answers (trust, MCP consent, login, unknown), or the dev-channel warning outside 4.4.
    case dialog(String)
    /// A cold start whose warning the guard refused to auto-confirm: the owner presses Enter in the pane.
    case confirmColdStart
    /// A restart whose warning the guard refused to auto-confirm.
    case restartNotConfirmed(AutoConfirmGuard.Refusal)
    /// Alive but missing from `claude agents --json` for two polls.
    case stuck
    /// Launched, but after `startWait` neither the dev-channel dialog nor the registration notice is on screen.
    case startStalled
  }

  public enum Event: Equatable, Sendable {
    case needsYou(NeedsYou)
    case openTerminal
    case humanConfirmed(sessionId: String)
    /// Quiet: "Talos restarted after a crash and resumed".
    case autoConfirmed(sessionId: String)
    case restarting(attempt: Int, delay: Double)
    case blocked([TakeoverCheck.Blocker])
    /// "Talos stopped restarting (crash loop)".
    case stoppedRestarting
    case resumeFailed(sessionId: String)
    case confirmFailed
    case stopped(StopReason)
    case attached(pid: Int32)
    /// Stop or Restart was pressed on a copy of the app that doesn't hold the session lock: it did nothing.
    case actionRefusedNotOwner
    /// The Mac restarted the agent, or put back the last good setup, because the owner asked or because it kept failing; or
    /// the restore failed and it stopped there.
    case recovered(AgentRecovery.Outcome)
    /// Main's development-channels warning was refused and is offered to the owner as a card (named moments for future hooks).
    case devCardOffered(dialogId: String)
    /// The owner's tap on that card was verified and the Mac pressed the key for it (`choice` is the card's button, 0 = the confirm).
    case devCardAnswered(dialogId: String, choice: Int)
  }

  public enum StartKind: String, Equatable, Sendable {
    case cold
    case supervisorRestart
    case attached
  }

  public struct Status: Equatable, Sendable {
    public var phase: Phase = .idle
    public var host: HostKind
    public var childPid: Int32?
    public var sessionId: String?
    public var startKind: StartKind?
    public var needsYou: NeedsYou?
    public var lastExit: ExitInfo?
    public var restartsInWindow = 0
    public var cliVersion: String?
    public var ownedGroups: Set<Int32> = []
    /// `status` of our pane's entry in the last `claude agents --json` poll (`busy`, `idle`, `waiting`); nil when the
    /// poll failed or the entry is missing. The status bar reads this instead of polling again.
    public var agentActivity: String?
    /// Main's dialog on its pane as an offer for the bridge's card (SupervisorDevCard.swift); `WorkerManager` writes it to `workers.json`.
    public var devDialog: DialogOffer?
    /// The Mac told the phone, for this start, that Main waits at the Mac (`postDevWaitingToPhone`): the popup's footer says so only then.
    public var devPhoneTold = false
  }

  struct Holder: Equatable {
    var pid: Int32
    var start: Double
  }

  struct Launch {
    var kind: StartKind
    var resumeId: String?
    var sessionId: String
    var startedAt: Double
    var childPid: Int32
    /// The child's start time (seconds since 1970; 0 if unread). A pid number alone is never "ours" (pid reuse).
    var leaderStart: Double = 0
    var fingerprint: String
    /// Per-piece hashes of this launch (folder, program, flags, env), so the card can say what differs from the confirmed one.
    var parts: [String: String] = [:]
    var cliVersion: String?
    var expectsDevDialog: Bool
    /// The channels this start's argv passed with `--dangerously-load-development-channels`: the only ones the warning may show.
    var launchedChannels: [String] = []
    /// `Options.awake` at the spawn (stops while the Mac sleeps): the 60 s window of the auto-accept counts from here.
    var awakeStartedAt: Double = 0
    /// The last reason the guard gave for not answering the warning (the log says it once per reason).
    var devRefusal: AutoConfirmGuard.Refusal?
    /// How many passes in a row gave `devRefusal` (a refusal that may clear by itself is held back for a few).
    var devRefusalPasses = 0
    var devDialogSeen: DialogMatcher.DevChannels?
    var confirmsSent = 0
    var confirmSentAt: Double?
    var noticeSeen = false
    var holders: [Holder] = []
    var notifiedScreens: Set<String> = []
    var agentsMisses = 0
    var reportedSessionId: String?
    /// The cold-start or refused-restart question the owner was told about the dev-channel dialog. A warning about another dialog
    /// takes the one `needsYou` slot; this is what goes back when the dev-channel dialog is on screen again.
    var question: NeedsYou?
    /// The folder this session was started in (the configured one at that moment). The config can name another folder later.
    var agentDir: String = ""
    /// A prompt of the CLI's nobody named on Main's screen: its stillness, and whether this run has looked at the screen yet.
    var promptWatch = PromptWatch()
    var promptChecked = false
    /// The refused development-channels warning as a card for the owner, and what has been taken from it (SupervisorDevCard.swift).
    var devCard = DevCard()
  }

  struct Cleanup {
    var pgid: Int32
    var deadline: Double
    var holders: [Holder]
    /// What happens once the group is gone.
    var then: AfterCleanup
  }

  enum AfterCleanup {
    case restart
    case stop(StopReason, closeHost: Bool, announcing: Event? = nil)
  }
}

final class WeakRef<T: AnyObject>: @unchecked Sendable {
  weak var value: T?
  init(_ v: T) { value = v }
}

enum AuditLog {
  static let lock = NSLock()
  static func append(_ line: String, to path: String) {
    lock.withLock {
      let dir = (path as NSString).deletingLastPathComponent
      try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
      let fd = open(path, O_WRONLY | O_CREAT | O_APPEND, 0o600)
      guard fd >= 0 else { return }
      _ = line.withCString { write(fd, $0, strlen($0)) }
      close(fd)
    }
  }
}
