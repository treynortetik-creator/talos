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
    /// After our Enter, the warning still on screen this long means the Enter did not take: the one `noNotice` stop. A missing channels
    /// notice is never a stop (Claude Code 2.1.322 prints none on a resumed start). Also: a start that never showed the warning counts as
    /// running once Claude's input box is up and this long has passed since the spawn.
    public var noticeWait: Double = 15
    /// How long a start may stay in `.starting` (neither the dev-channel dialog nor the registration notice recognised on
    /// screen) before the owner is told. Far longer than a slow start needs; it only ends a wait that would never end.
    public var startWait: Double = 120
    public var dialogStall: Double = 60
    /// A prompt of the CLI's that Talos has no name for counts after its region of the screen has held still this long.
    public var promptSettle: Double = 5
    /// A tool permission or question offered as a card whose card the phone has not acknowledged by now gets the plain line (the CLI path), like a thread's
    /// `cardAckWait`; and its stall alarm (the unknown-question warning, which opens Terminal) is held back this long while the offer stands.
    public var paneCardWait: Double = 15
    public var paneStallAfter: Double = 600
    /// ... and while an attached client has not typed for this long (an owner-opened picker is not waiting on anybody).
    public var promptClientQuiet: Double = 30
    /// The dev-channels warning is answered only while no attached tmux client has typed for this long (or when the clients cannot be read: never).
    /// tmux reports a client's activity in whole seconds, so the quiet needed is up to a second longer than this.
    public var devDialogClientQuiet: Double = 5
    /// How long Main's safety question is not offered again after an Enter whose delivery is unknown (a tmux timeout): it may have landed and the
    /// screen not yet redrawn. Past it, the same unchanged screen is clearly still waiting and is offered again.
    public var safetyUnsentMemory: Double = 5
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
    /// How long after the warning is answered Main's bridge has to show a live status (`status.json`) before the owner is told.
    public var bridgeWait: Double = 60
    /// An exit this soon after the spawn with the CLI's resume error on screen is a failed `--resume`. Later, the same words on
    /// screen are conversation (a transcript that quotes them) and the exit is a crash, also for a start still on its warning. The
    /// contract's `MAIN_RESTART.resume_error_within_s` (one number for every platform; 10 s was too tight on a loaded machine).
    public var resumeMissingWindow: Double = MainRestartContract.resumeErrorWithinS
    /// The contract's `MAIN_RESTART.cannot_launch_tries`: tries of a restart after a crash that cannot launch at all, before it gives up.
    public var cannotLaunchTries: Int = MainRestartContract.cannotLaunchTries
    /// The contract's `MAIN_RESTART.clean_exits_per_hour` (packages/protocol/src/supervisor.ts; `ConfigFileReadTests.theCleanExitCapIsTheContractsNumber` reads the
    /// number from that file, so this cannot drift from it): more exits with code 0 than this within `cleanExitWindow` stop Main.
    public var cleanExitsPerHour: Int = MainRestartContract.cleanExitsPerHour
    public var cleanExitWindow: Double = 3600
    /// `main-restart-check.json` is rewritten this often (`MainRestartCheck.writeEvery`, the contract's 5 s), on the tick.
    public var restartCheckEvery: Double = MainRestartCheck.writeEvery
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
    /// Main's Talos bridge must show a live `status.json` within `Timings.bridgeWait` of the warning being answered, or the owner is told.
    /// Off unless the app turns it on: a supervisor with no bridge behind it (tests, a thread session) has nothing to check.
    public var checksBridge: Bool = false
    /// Main always passes `--dangerously-load-development-channels server:talos-app` (`MainChannelFlag`), whatever command was saved or
    /// imported. Off unless the app turns it on, like `checksBridge`: a supervisor under test has the launch its test gave it.
    public var addsChannelsFlag: Bool = false
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
    /// The app already found `desktop.json` unreadable (it chose the host from the defaults then): this supervisor starts and saves
    /// nothing, even if the file reads fine a moment later. The supervisor also checks for itself.
    public var configKnownUnreadable = false
    /// Where the guards' refresh looks for bun (nil: `GuardsRefresh.bunCandidates`); a test points it at its own.
    public var guardsBunCandidates: [String]?
    /// Temp folders a bun or a checkout is never pinned in (`GuardsRefresh.tmpRoots`); a test whose fixtures live in one empties it.
    public var guardsTmpRoots: [String] = GuardsRefresh.tmpRoots
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
    /// The contract's `clean_exit_loop`: more than `Timings.cleanExitsPerHour` exits with code 0 in an hour. Not a crash loop
    /// (nothing is restored), but nothing restarts it either.
    case cleanExitLoop
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
    /// Main is running but its Talos bridge (the talos-app MCP server) has not written a live status after the window; the reason
    /// is the last line of Claude Code's MCP log for that server, when it could be read.
    case bridgeNotLive(String?)
    /// Main's bridge was live and has reported no relay connection for `MainRestartContract.relayDownS` (the contract's
    /// `bridge_not_live` once live); the last close code it reported, if any (MainWatch.swift).
    case relayUnreachable(Int?)
    /// Main was told about an owner message and has not acted on it, with its pane silent since (the contract's `stuck` by
    /// `unseen_s`). Never restarted for it.
    case notReading
    /// Main was told about an owner message (the time it carries) and has made no tool call, while its working line, screen and
    /// transcript show no progress for `MainRestartContract.stallS`: the model request may be stuck. The second value is what the
    /// auto-unstick did (`MainWatch.Unstick`; `.none` = nothing pressed or re-sent, the owner decides).
    case stalled(Date, MainWatch.Unstick)
  }

  public enum Event: Equatable, Sendable {
    case needsYou(NeedsYou)
    case openTerminal
    /// Main is signed out: the app opens the Sign in to Claude again window (never a terminal).
    case openSignIn
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
    /// A start or a settings change was refused because `desktop.json` is there and cannot be read.
    case configUnreadable
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
    /// Main's tool permission or the agent's own question as an offer (SupervisorPanePrompt.swift): the Mac popup lists it, and it goes into `workers.json`
    /// beside `devDialog` for the bridge's card. Never both at once.
    public var paneDialog: DialogOffer?
    /// Main's API-key question as a Mac popup offer (`SupervisorFirstStart`). Not written to workers.json: there is no phone card for it yet.
    public var apiKeyDialog: DialogOffer?
    /// Main's MCP-server question or bypass disclaimer as a Mac popup offer (`SupervisorSafetyPopup`), answered only by a real click.
    public var safetyDialog: DialogOffer?
    /// The Mac told the phone, for this start, that Main waits at the Mac for one of those two (`postSafetyWaitingToPhone`).
    public var safetyPhoneTold = false
    /// The Mac told the phone, for this start, that Main waits at the Mac (`postDevWaitingToPhone`): the popup's footer says so only then.
    public var devPhoneTold = false
    /// Main's Talos bridge was seen live (`status.json`, from this start's child) in this start. The setup screen's "done" waits for it.
    public var bridgeLive = false
    /// `desktop.json` is there and could not be read when the app started: nothing is started and nothing is saved in this run.
    public var configUnreadable = false
    /// The mode the main session, as launched, runs in that no thread session can be held to (`MainNarrowed`); nil when in none.
    public var mainNarrowed: String?
    /// The saved launch command is not the one this agent started with (`LaunchPending`): the Session tab offers a restart.
    public var launchPending = false
    /// The saved arguments the running agent was started from, nil when not known (a pane found running with another command). Thread
    /// sessions are held to these, never to a saved command the agent has not started with (`LaunchPending.argsForThreads`).
    public var runningArgs: [String]?
    /// The permission mode of the launch now running or waiting (its own arguments at the spawn, never the saved ones): what Main's
    /// startup popup names. nil when the arguments read as no one mode or are not known.
    public var devStartMode: String?
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
    /// The saved arguments (`desktop.json` `args`) this start was made from; nil for a pane found running with some other command.
    var launchedArgs: [String]?
    var cliVersion: String?
    var expectsDevDialog: Bool
    /// The channels this start's argv passed with `--dangerously-load-development-channels`: the only ones the warning may show.
    var launchedChannels: [String] = []
    /// The mode this start runs in that narrows it beyond a thread session's reach (`MainNarrowed`): by the arguments and environment
    /// it was given, or, for a pane found running, by its real arguments. No thread session starts while it is in one.
    var narrowed: String?
    /// `Options.awake` at the spawn (stops while the Mac sleeps): the 60 s window of the auto-accept counts from here.
    var awakeStartedAt: Double = 0
    /// The last reason the guard gave for not answering the warning (the log says it once per reason).
    var devRefusal: AutoConfirmGuard.Refusal?
    /// How many passes in a row gave `devRefusal` (a refusal that may clear by itself is held back for a few).
    var devRefusalPasses = 0
    var devDialogSeen: DialogMatcher.DevChannels?
    var confirmsSent = 0
    var confirmSentAt: Double?
    /// The dev-channels warning of this start was answered (see `markAnswered`), or there was none to answer.
    var dialogAnswered = false
    /// `Options.wallClock` at the spawn: a bridge status stamped before it belongs to an earlier start.
    var startedWallMs: Double = 0
    /// Main's bridge: when the warning was answered (the clock the window counts from), and whether it has been seen live in this start.
    var answeredAt: Double?
    var bridgeSeenLive = false
    /// The bridge alarm as raised, kept so it can come back when a dialog that took the one `needsYou` slot is answered.
    var bridgeAlarm: NeedsYou?
    /// Main's live bridge off the relay, and Main not reading its messages (SupervisorMainWatch.swift).
    var mainWatch = MainWatch()
    var holders: [Holder] = []
    var notifiedScreens: Set<String> = []
    /// The first-start screens answered with their one Enter in this start (`SupervisorFirstStart`), by `FirstStartScreens.Screen.rawValue`.
    var firstStartEntered: Set<String> = []
    /// Main's API-key question as a popup offer, and the dialog id a key was sent for (no second key for it).
    var apiKeyOffer: DialogOffer?
    var apiKeyPressedFor: String?
    /// Main's MCP-server question or bypass disclaimer as a popup offer (`SupervisorSafetyPopup`), the dialog id a key was sent for, and the
    /// phone line (once per start).
    var safetyOffer: DialogOffer?
    var safetyPressedFor: String?
    var safetyPhonePosted = false
    /// The owner's "No, exit" on the bypass disclaimer ended this start: the exit that follows is his stop (`stopsForOwnerExit`). Its own flag, not
    /// the dev card's (`syncDevCard` clears that one every tick once the start runs), and gone with this `Launch` when a new start begins.
    var safetyOwnerExit = false
    /// The screen (its rows joined) the last safety Enter went to: the same screen is not offered again until it changes (a redraw that lags, or a
    /// dead pane's last frame).
    var safetyAnsweredScreen: String?
    /// The same, for an Enter whose delivery is UNKNOWN (a timeout, not `notSent`): the screen it went to and the awake time the memory ends. Short
    /// lived (`Timings.safetyUnsentMemory`): if the screen is still the same after it, the key never reached Claude and the question is offered again.
    var safetyUnsentScreen: String?
    var safetyUnsentUntil: Double = 0
    var safetyPhoneTold = false
    /// Main's tool permission or the agent's question as an offer (SupervisorPanePrompt.swift), the screen it was made for (`PaneSelect.Screen.bound`),
    /// what the pane showed at the last look, since when and since when it has shown none (the supervisor's clock), the dialog id a key was sent for,
    /// the screen whose answer key was confirmed (not offered again while it stands) and the one whose key's delivery is unknown (the short memory).
    var paneOffer: DialogOffer?
    /// When (supervisor clock) the standing offer was made, and the offer the phone line was posted for.
    var paneOfferedAt: Double = 0
    var paneLineFor: String?
    var paneBound: String?
    var paneSeen: String?
    var paneSince: Double = 0
    var paneGone: Double?
    var panePressedFor: String?
    var paneAnswered: String?
    var paneUnsent: String?
    var paneUnsentUntil: Double = 0
    var paneControlsSeen: [String] = []
    var paneProofsUsed: [String] = []
    /// The pane's last output as the host last reported it (a wall time), and when on the supervisor's clock that report last changed.
    /// The dialog stall is timed from the second, so a Mac clock set forward cannot raise it early nor one set back hold it off.
    var outputSeen: Date?
    var outputChangedAt: Double = 0
    var agentsMisses = 0
    var reportedSessionId: String?
    /// The cold-start or refused-restart question the owner was told about the dev-channel dialog. A warning about another dialog
    /// takes the one `needsYou` slot; this is what goes back when the dev-channel dialog is on screen again.
    var question: NeedsYou?
    /// The folder this session was started in (the configured one at that moment). The config can name another folder later.
    var agentDir: String = ""
    /// A prompt of the CLI's nobody named on Main's screen: its stillness, and whether this run has looked at the screen yet.
    var promptWatch = PromptWatch()
    /// Where Main's transcript was last found (SupervisorMainWatch.swift): the project folder, the newest file in it, and when it was last looked for.
    var transcriptLook = TranscriptLook()
    /// "The bridge cannot resend" was audited for this launch (once).
    var noResendNoted = false
    var promptChecked = false
    /// The refused development-channels warning as a card for the owner, and what has been taken from it (SupervisorDevCard.swift).
    var devCard = DevCard()
    /// This start is the restart after an exit with code 0: its auto-answer counts with the cold starts', not the crash loop's.
    var afterCleanExit = false
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

struct TranscriptLook {
  var folder: String?
  var file: String?
  var lookedAt: Double?
}
