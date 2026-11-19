import Foundation
import TalosDesktopCore

/// Option C: one interactive Claude Code session per thread that the owner switched to "Own session" (docs/OPTION-C.md).
/// Starts a worker in tmux on the first message, types the fixed pointer line, parks it after the idle time, resumes it
/// by session id on the next message, and writes `workers.json` (with a 5 s heartbeat) for main's bridge.
///
/// House rules (OPTION-C 4.3, 4.4, R-19): a worker never gets channels, `-p`, `--bg` or a Telegram token (`WorkerSpec`
/// refuses them); its environment is replaced wholesale with `env -i`, so nothing leaks in from the tmux server; only
/// process groups this manager started are ever signalled, through `GroupSignaller`; the CLI's MCP health listing is
/// never run; the only text ever typed is `PointerTyper.text` (and a tap's Up, Down and Enter for a known dialog: WorkerDialogAnswer.swift); and a worker is never stopped mid-turn on its own account:
/// every park (idle, governor, switch-off, restart) waits for the turn to end. The one exception is the owner's own: 15
/// minutes after a tap (Restart, Start fresh, Park now, or switching the thread off), a turn that still hasn't ended is
/// stopped, so a hung one can't hold the thread for ever. The governor never does this.
///
/// A read that fails says nothing. A tmux read that can't be trusted, or a config that can't be parsed, leaves the worker
/// exactly as it is: nothing is typed, signalled, killed, started or marked failed on a guess, and the next tick looks again.
/// A worker is gone only when tmux itself says so, or the kernel says its group is empty.
///
/// Only one copy of the app runs workers: the holder of `$TALOS_APP_HOME/workers.lock`. Any other copy stays passive and
/// writes nothing, and takes over if the holder goes away.
public final class WorkerManager: @unchecked Sendable {
  public struct Options: Sendable {
    public var talosHome: String
    public var agentDir: String
    public var claudePath: String
    /// The owner's permission flag from desktop.json when main uses it (`--dangerously-skip-permissions`).
    public var permissionFlag: String?
    /// The thread sessions' PermissionRequest hook source: the app bundle's sealed copy (`WorkerHook.appSource`), never a checkout.
    /// nil = none was given, and no thread session starts (`WorkerHookStart.swift`).
    public var permissionHook: WorkerHook.BundleSource?
    /// Main's real launch arguments from desktop.json. Its permission mode is worked out from these (`--permission-mode X` as well as
    /// `--dangerously-skip-permissions`); empty = just `permissionFlag`.
    public var mainArgs: [String] = []
    /// Claude Code's managed settings folder, read for the privilege ceiling (`MainManagedSettings`). The app passes the system's;
    /// nil reads none, so a test never reads this Mac's.
    public var managedDir: String?
    /// Where to write one line for every MCP server of a thread's own folder that a session is started with (nil = nowhere).
    public var auditLogPath: String?
    public var tmux: String
    public var socket: String = TmuxCommands.defaultSocket
    public var tmuxConf: String
    /// The owner's home folder, for the folder re-check before each start.
    public var home: String = NSHomeDirectory()
    public var tick: Double = 1
    public var heartbeat: Double = 5
    public var callTimeout: Double = 10  // each tmux (or other) command of the tick
    public var readyTimeout: Double = 90
    public var parkGrace: Double = 5
    public var capHold: Double = 120
    /// Output newer than this marks a worker busy (no parking, no cap victim).
    public var busyWindow: Double = 15
    /// How long an owner's stop waits for the turn to end, from the tap. On the awake clock. 15 min outlasts any single tool
    /// (the Bash tool's ceiling is 10) and 98.9 % of the turns measured on this owner's sessions.
    public var stopLimit: Double = 900
    /// How long a worker found `stopping` after a relaunch may still take to end its turn, counted from when the stop was asked for
    /// (`stopping_since`, or the relaunch for a file that has none). Whose stop it was is not on disk and the governor's has no limit
    /// of its own, so this one stands for every adopted stop: 10 min, the Bash tool's ceiling. Then the turn is cut and the thread told.
    public var adoptedStopLimit: Double = 600
    /// The least an adopted stop waits after the relaunch, whatever the file says about when it was asked for: the file can be edited
    /// while the app is down, the time away is wall clock (a closed lid counts), and a turn that ended just before the relaunch still
    /// reads as running for `busyWindow`. So no turn is cut on the file's word alone at the first look.
    public var adoptedStopFloor: Double = 120
    /// How long a worker may sit on a dialog during its start before it is stopped as `needs_mac`. The owner answers the dialog
    /// in the Terminals window meanwhile; the ready timeout does not run while it is on screen. On the awake clock.
    public var dialogLimit: Double = 900
    /// Wait before a failed notice post is tried again (three tries, then the app says so).
    public var noticeRetry: Double = 30
    /// A dialog on a running (live or busy) worker counts only after the pane has been unchanged this long.
    public var dialogSettle: Double = 5
    /// At most one notice per thread per kind of dialog in this time, whatever the screen does.
    public var noticeDebounce: Double = 600
    public var promptDebounce: Double = 5  // the same, for prompts nobody named: each tool asks again
    public var clientQuiet: Double = 30  // a prompt waits while an attached client typed this recently (the owner's own picker)
    /// The most that typing holds back the line for a TOOL prompt (Bash, a file create or edit), from when that prompt first showed.
    public var toolPromptHoldMax: Double = 60
    /// A pointer held back by a draft this long gets one line in its thread.
    public var draftNoticeAfter: Double = 120
    /// A known dialog offered to the bridge for a tap: how long the Mac waits for its card (`dialog-card.json`) before it posts its own line, and how long the card lives.
    public var cardAckWait: Double = 15
    public var cardLifetime: Double = 900
    /// A change to a running session's folder, model, effort or MCP list is acted on once it has stood this long (awake clock).
    public var launchChangeSettle: Double = 30
    /// Tests: park after this many seconds instead of the thread's `idle_park_min`.
    public var idleSecondsOverride: Double?
    public init(
      talosHome: String, agentDir: String, claudePath: String, permissionFlag: String?, tmux: String, tmuxConf: String
    ) {
      self.talosHome = talosHome
      self.agentDir = agentDir
      self.claudePath = claudePath
      self.permissionFlag = permissionFlag
      self.tmux = tmux
      self.tmuxConf = tmuxConf
    }
  }

  public enum Event: Equatable, Sendable {
    case started(thread: String, resume: Bool)
    case live(thread: String)
    case pointer(thread: String)
    case parked(thread: String, reason: String)
    case failed(thread: String, code: String)
    /// A worker's pane is showing a dialog (workspace trust, MCP consent, login …) and waits for the owner. `prompt` is in the
    /// owner's words (`WorkerNotice.promptName`).
    case needsYou(thread: String, prompt: String)
    /// The line telling the thread about it could not be posted (tried three times).
    case noticeFailed(thread: String)
    /// workers.json held entries this build cannot read (WorkersFileRead.swift): kept as they were, and these threads' own sessions
    /// are not started. `others` counts the keys that are not thread ids, which are never named. Once per launch.
    case recordsUnreadable(threads: [String], others: Int)
    /// workers.json cannot be read at all: nothing is saved over it, and no thread session runs, until it reads or is removed.
    case fileUnreadable
  }

  /// One kind of notice: sent, in flight, how often a clear failure was retried, and when it may be tried again. `episode` counts
  /// the dialogs (or holds) on this pane; a post's answer only counts for the episode it was sent for.
  struct NoticeState {
    var sent = false
    var inFlight = false
    var attempts = 0
    var retryAt: Double = 0
    var episode = 0
    mutating func reset() {
      sent = false
      inFlight = false
      attempts = 0
      retryAt = 0
      episode += 1
    }
  }

  struct Runtime {
    var entry: WorkersFile.Entry
    var paneId: String?
    var pgid: Int32 = 0
    var startedAt: Double = 0
    var readyAt: Double = 0
    /// The last real activity: a pointer, a change in `body`, or an attached client's key (`WorkerIdle.swift`). Never raw pane output.
    /// On the wall clock: what `workers.json` keeps. Nothing is decided by it.
    var lastActive: Double = 0
    /// The same on the awake clock: what the idle park and the cap's ranking read, so a wall clock that jumps changes neither.
    var activeAwake: Double = 0
    /// The screen above the input box's lower rule at the last tick (`WorkerActivity.body`); nil before the first look.
    var body: String?
    var pendingPointer = false { didSet { if !pendingPointer { owed = OwedState() } } }  // nothing owed, nothing left of its hold
    var owed = OwedState()  // the deadline of that pointer, and how a relaunch settles it (WorkerOwedPointer.swift)
    /// On the awake clock.
    var parkDeadline: Double?
    /// A stop gives up waiting for the turn at this time, on the awake clock: an owner's (`stopLimit` from the tap), or one found
    /// `stopping` after a relaunch (`adoptedStopLimit` from `stopping_since`). The governor's own, in the copy that asked for it, has none.
    var stopDeadline: Double?
    /// The stop was found in the file after a relaunch: if its limit cuts the turn, the thread is told (`cutNote`).
    var stopAdopted = false
    /// The line for a turn that limit cut, until it has gone (a clear failure is tried again, as every notice is).
    var cutLine: String?
    var cutNote = NoticeState()
    /// The line for a park that cut background work, until it has gone (WorkerBackground.swift), and whether the idle park is held by it.
    var bgCutLine: String?
    var bgCutNote = NoticeState()
    var bgHeld = false
    var parkReason: String?
    /// A `restart`, `fresh` or `resume` that arrived while the worker was on its way out: run when it's gone.
    var afterPark: String?
    var restartTimes: [Double] = []
    /// A start waiting for a free slot (`hold`), and since when.
    var heldSince: Double?
    var heldResume = false
    /// The held start waits because tmux could not be read (not because every slot is busy): past `capHold` it fails, never goes quiet.
    var heldUnreadable = false
    /// The pointer's text is in the input and its Enter failed: send only the Enter.
    var enterOwed = false
    /// A running worker adopt couldn't read yet: hands off until it can.
    var adoptPending = false
    /// `startedAt` on the awake clock.
    var startedAwake: Double = 0
    var seenActivity: Double?
    /// When `seenActivity` last changed, on the awake clock.
    var activityChangedAwake: Double?
    /// The dialog this worker's pane is showing now, in the owner's words. Memory only: a dialog is a screen, not a state.
    var needsYouPrompt: String?
    /// When (wall clock, ISO) `needsYouPrompt` was raised: `needs_you.since` in workers.json.
    var needsYouAt: String?
    /// The usage-limit screen's reset (ISO), worked out when it appeared: `needs_you.resets_at`, written only under that kind.
    var needsYouResetsAt: String?
    /// The computer-use permission dialog's Escape: per appearance, per hour (WorkerComputerUse.swift). Kept across starts.
    var cu = ComputerUseDismiss()
    /// The usage-limit screen: its appearances and the hourly line (WorkerUsageLimit.swift). Kept across starts.
    var ul = UsageLimitWatch()
    /// The line for the usage-limit screen on the pane now, while it may still go (one per appearance, at most one an hour).
    var ulLine: String?
    /// The unnamed prompt the flag was raised for (its signature's hash); nil for a known dialog. Another one under the held flag is a new ask.
    var flaggedPrompt: String?
    /// When (awake clock) the current dialog was first seen.
    var dialogSinceAwake: Double?
    var dialogAbsence = DialogAbsence()  // awake clock: since the pane showed no dialog shape at all; clears a held flag (noteScreens)
    /// The notice for the dialog on screen now (`dlg`), for a pointer held back by a draft (`held`) or by no input box (`noBox`).
    var dlg = NoticeState()
    var held = NoticeState()
    var noBox = NoBoxHold()
    var copyHold = CopyModeHold()
    /// A pointer the key guard refused (`KeyGuard`): since when, and its one notice.
    var refusedHold = NoBoxHold()
    /// A pointer typed and never seen in the input box (`WorkerNotice.unseenKind`): since when, and its one notice.
    var unseenHold = NoBoxHold()
    /// The one notice for a pointer whose Enter may have answered a prompt (`EnterDetection`, `WorkerNotice.enterUncertainKind`).
    var enterHold = NoticeState()
    /// The Enter check under way for this worker's last pointer (`scheduleEnterCheck`): a newer one takes over.
    var enterCheckToken = 0
    /// Since when (awake clock) the pointer has been held by text in Claude's input box; nil when it isn't.
    var draftSince: Double?
    /// Whether this worker's notice records were checked against its screen since this copy of the app took it over.
    var recordsChecked = false
    /// The last screen text read and since when (awake clock): a dialog counts once the screen has held still.
    var screenText: String?
    var screenSameSince: Double = 0
    /// Prompts nobody named: the one announced, and its stillness (`PromptDetector`).
    var promptWatch = PromptWatch()
    /// The prompt on the pane (its signature's hash) and when (awake clock) it first showed: the clock of `toolPromptHoldMax`.
    var heldPrompt: (hash: String, since: Double, logged: Bool, missing: Double?)?
    /// The tap-answerable dialog on the pane: since when it was offered, which answers were taken (WorkerDialogOffer.swift).
    var offer = OfferState()
    /// A change to what the session was launched with, waiting out its settle time (WorkerLaunchChange.swift).
    var change = LaunchChange.Debounce()
    /// Since when (awake clock) this running sub-thread's settings have refused a start (WorkerSubThreads.swift); nil when they do not.
    var subRefusedSince: Double?
    /// The folder a fresh restart is for: the thread is told about it once the new session has started.
    var folderChangeTo: String?
    /// The lines about the launch: a new folder, MCP servers not found, a refused spec. `fenceKinds` is the kind each slot last told.
    var folderNote = NoticeState()
    var missingNote = NoticeState()
    var refusedNote = NoticeState()
    var ceilingNote = NoticeState(), mainSettingsNote = NoticeState(), hookNote = NoticeState(), ignoredSettingsNote = NoticeState()
    /// When the thread was last told a new reason its permission hook refuses a start (awake clock): one new reason a minute at most.
    var hookToldAt: Double?
    var fenceKinds: [AnyHashable: String] = [:]
    /// Whether the start now running (or the last one) was `--resume`; nil for one this copy of the app did not make.
    var startedAsResume: Bool?
    /// The id the CLI refused for `--session-id` as already in use: it has a saved conversation the look did not find, so it is
    /// resumed from then on, whatever a later look says. Memory only: a relaunched app finds it out again, in one refused start.
    var resumeAnyway: String?
    /// A new id was given for a file with nothing to resume, and no start has gone live since: the next such refusal stops the
    /// thread instead of making another id.
    var gaveNewId = false
  }

  /// Read under `publishedLock`: the tick rewrites the launch fields on the queue while the Terminals window reads this on the
  /// main thread, so a plain stored struct was a data race. One value at a time, never half a launch source.
  public private(set) var options: Options {
    get { publishedLock.withLock { _options } }
    set { publishedLock.withLock { _options = newValue } }
  }
  private var _options: Options
  /// The login environment workers run with (a hand-opened claude for a needs_mac row uses the same one).
  public func loginEnvironment() -> [String: String] { baseEnv() }
  /// What the next start launches, read at each tick instead of captured at launch (audit D10): the folder and the claude path
  /// the owner sets up after Talos is already open. nil keeps `options` as built.
  public struct LaunchSource: Sendable, Equatable {
    public var agentDir: String
    public var claudePath: String
    public var permissionFlag: String?
    public var mainArgs: [String]
    public init(agentDir: String, claudePath: String, permissionFlag: String?, mainArgs: [String] = []) {
      self.mainArgs = mainArgs
      self.agentDir = agentDir
      self.claudePath = claudePath
      self.permissionFlag = permissionFlag
    }
  }
  public var launchSource: (@Sendable () -> LaunchSource)?
  /// Whether the login shell's environment has been read since the app opened. nil = not asked (a start never waits on it).
  /// See the hold at the top of `start`.
  public var hasLoginEnv: (@Sendable () -> Bool)?
  /// The narrowing mode the main session, as it was launched, runs in (`MainNarrowed`, WorkerMainNarrowed.swift); nil = none, or not known here.
  public var mainRunsNarrowed: (@Sendable () -> String?)?
  public var onEvent: (@Sendable (Event) -> Void)?
  /// Posts one plain line into a thread through the bridge (`talos-app post <thread> <text>`). Blocking; called off the worker
  /// queue. `talos-app post` takes no message key, so a timeout (`unknown`) is never retried: it may have been sent. nil = this build can't post (the notice then shows only in the Mac app).
  public var postNotice: (@Sendable (_ thread: String, _ text: String) -> PostOutcome)?
  /// Brings the Terminals window to a thread (a tap on "Open on the Mac"); false when no window can be shown.
  public var openTerminals: (@Sendable (_ thread: String) -> Bool)?
  /// The process table the background-work look reads (WorkerBackground.swift); nil = it could not be read. Tests swap it.
  public var procTable: @Sendable () -> [BackgroundWork.Proc]? = { ProcTable.live() }
  /// One process's argv, for the first background task's command (WorkerBackground.swift).
  public var procArgv: @Sendable (Int32) -> [String]? = { ProcessInspect.snapshot($0)?.argv }
  public let signaller: GroupSignaller
  let probe: SystemProbe
  let baseEnv: @Sendable () -> [String: String]
  let mainPanePid: @Sendable () -> Int32
  let mainDialogFeed = MainDialogFeed()
  let now: @Sendable () -> Double
  /// Seconds that stop while the Mac sleeps and never jump. The wall clock can't time a turn, a grace or a start: after a
  /// sleep or a clock change every wait on it looks long over.
  let awake: @Sendable () -> Double
  let queue = DispatchQueue(label: "talos.workers")
  var timer: DispatchSourceTimer?
  let watch = TickWatch()  // what the tick is doing, for the watchdog
  var watchdog: WorkerWatchdog!
  /// Held while ticking (NapGuard.swift); tests swap it before `startTicking`.
  public var napGuard: NapGuard = ProcessActivityNapGuard(reason: "Talos supervises the thread sessions")
  var rt: [String: Runtime] = [:]
  /// When each thread was last told a new set of its folder's files its session started without (awake clock), across starts: one
  /// new set a minute at most (WorkerHookStart.swift).
  var ignoredToldAt: [String: Double] = [:]
  private var adopted = false
  /// The entries of workers.json this build could not read, and whether the whole file could not be read (WorkerAdopt.swift).
  var unreadableKept: [String: String] = [:]
  var fileRefused = false
  private var lastHeartbeat: Double = 0
  /// The wall clock less the awake clock at the last look (`noteClock`, WorkerIdle.swift); nil before the first.
  var wallOffset: Double?
  var dirty = false
  /// nil until a config has been read: not knowing the settings is not the same as "off".
  private var lastSettings: DedicatedSettings?
  /// Restart on update (WorkerUpdateRestart.swift): what it reads from the app, and its own state.
  public var updateRestart = UpdateRestartWiring()
  var updateState = UpdateRestartState()
  /// The `config.threads` entries left out that the owner was last told about, and how often that line clearly failed (WorkerSubThreads.swift).
  var droppedSaid = ""
  var droppedTries = 0
  var droppedRetryAt: Double = 0
  var stopped = false
  /// The shapes of unknown status parts already in the audit this run (`noteUnknownStatusParts`).
  var unknownShapesSeen = Set<String>()
  /// The shapes of refused status parts already in the audit this run (`noteRefusedStatusParts`).
  var refusedShapesSeen = Set<String>()
  /// "Quit and stop" has finished (WorkerStopAll.swift). Read under `publishedLock`.
  var _allStopped = false
  /// Since when (awake clock) each thread with an entry has been missing from the dedicated threads (WorkerForget.swift).
  var absentSince: [String: Double] = [:]
  var lockFd: Int32 = -1
  /// What `snapshot()` and `needsYou()` return; see WorkerPublished.swift.
  let publishedLock = NSLock()
  var _published: Published!

  public init(
    options: Options, probe: SystemProbe, baseEnv: @escaping @Sendable () -> [String: String],
    mainPanePid: @escaping @Sendable () -> Int32 = { 0 },
    now: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 },
    awake: @escaping @Sendable () -> Double = { Double(DispatchTime.now().uptimeNanoseconds) / 1e9 }
  ) {
    self._options = options
    self.probe = probe
    self.signaller = GroupSignaller(probe: probe)
    self.baseEnv = baseEnv
    self.mainPanePid = mainPanePid
    self.now = now
    self.awake = awake
    publish()
    watchdog = WorkerWatchdog(manager: self)
  }

  // MARK: paths

  var workersJson: String { options.talosHome + "/workers.json" }
  func dir(_ id: String) -> String { options.talosHome + "/workers/" + id }
  var configJson: String { options.talosHome + "/config.json" }
  var lockPath: String { options.talosHome + "/workers.lock" }

  /// Process groups of our live workers (main's TakeoverCheck whitelists them, OPTION-C 4.4).
  public var ownedGroups: Set<Int32> { signaller.ownedGroups }

  /// Changes the options (before ticking starts; tests tune the waits).
  public func tune(_ edit: (inout Options) -> Void) {
    queue.sync {
      edit(&options)
      publish()
    }
  }

  /// This copy runs the workers. A second copy of the app stays passive.
  public var isActive: Bool { queue.sync { lockFd >= 0 } }

  // MARK: run loop

  /// The public watchdog of the loop (WorkerWatchdog.swift): tests tune it and call `check()`.
  public var heartbeatWatchdog: WorkerWatchdog { watchdog }

  /// One tick, synchronously (tests).
  public func tickOnce() { queue.sync { tickLocked() } }

  func emit(_ e: Event) { onEvent?(e) }

  /// `flock` on `workers.lock`: the same rule as main's session lock (D1), so a dev build next to the installed app can't
  /// heartbeat over this one or take its wakes.
  private func tryLock() -> Bool {
    if lockFd >= 0 { return true }
    let fd = open(lockPath, O_RDWR | O_CREAT | O_CLOEXEC, 0o600)
    guard fd >= 0 else { return false }
    guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
      close(fd)
      return false
    }
    lockFd = fd
    return true
  }

  func releaseLock() {
    guard lockFd >= 0 else { return }
    // close() alone leaves the flock held while any copy of the open file description lives (a spawn in flight holds one until
    // exec), so the next manager's tryLock would fail. Unlock first, as Supervisor.releaseLock does.
    flock(lockFd, LOCK_UN)
    close(lockFd)
    lockFd = -1
  }

  func tickLocked() {
    watch.beginTick(at: awake())
    defer {
      publish()
      watch.endTick(supervising: !stopped && lockFd >= 0 && timer != nil, at: awake())
    }
    guard !stopped, tryLock() else { return }
    if let src = launchSource?() {
      var o = options
      o.agentDir = src.agentDir
      o.claudePath = src.claudePath
      o.permissionFlag = src.permissionFlag
      o.mainArgs = src.mainArgs
      options = o
    }
    let t = now()
    let (settings, fresh) = readSettings()  // `fresh`: this tick's own read worked (restart on update runs no round on a stale one)
    watch.step("adopt", at: awake())
    if !adopted {
      guard adopt(now: t) else { return }  // a file that cannot be read: nothing runs, and nothing is saved over it
      adopted = true
    } else {
      for (id, r) in rt where r.adoptPending { adoptOne(id, now: t) }
    }
    // a thread switched back to shared, or the master switch off: park after the current turn
    if let settings {
      for (id, r) in rt where settings.threads[id] == nil {
        if WorkersFile.liveStates.contains(r.entry.state) {
          requestPark(id, reason: "switched_off", byOwner: true)
        } else if r.entry.state == "stopping" {
          armStopLimit(id)
        } else if WorkersFile.restingStates.contains(r.entry.state) {
          // no session of its own any more: the generated file with its servers' credentials goes (looked at each tick, so quietly)
          _ = removeListConfig(id, quiet: true)
        }
      }
      // an entry that was left out may be one of these threads with a typo in it: nothing is forgotten until the config reads whole
      if settings.droppedEntries.isEmpty { forgetUndedicated(settings) }
      parkUnderNarrowedMain()
    }
    watch.step("advance", at: awake())
    noteClock()  // a wall clock that jumped never makes a session look idle
    for id in Array(rt.keys) {
      advance(id, settings: settings ?? .off, now: t)
      publish()  // a long tick shows its progress
    }
    watch.step("wakes", at: awake())
    if let settings {
      reviveOwed(settings: settings, now: t)
      takeWakes(settings: settings, now: t)
      publish()
      retryHeld(settings: settings, now: t)
      enforceCap(settings: settings, now: t)
      checkLaunchChanges(settings: settings, now: t)
      updateRestartTick(settings: settings, fresh: fresh)
      retryMainSettingsNotes()
    }
    clearFolderClaims(settings ?? .off)
    if mainDialogFeed.changed() { dirty = true }  // Main's card appears (or goes) within the tick
    // abs: after the clock goes back, a heartbeat must not wait for it to catch up
    if abs(t - lastHeartbeat) >= options.heartbeat || dirty {
      writeFile()
      lastHeartbeat = t
      dirty = false
    }
  }

  // MARK: settings and files

  /// The agent config, or the last good one when the file can't be read: a half-saved hand edit must not read as "off"
  /// and park every worker. nil when no config has been readable since launch.
  func loadSettings() -> DedicatedSettings? { readSettings().settings }

  /// The same, and whether this very read worked.
  func readSettings() -> (settings: DedicatedSettings?, fresh: Bool) {
    guard let d = FileManager.default.contents(atPath: configJson), let s = DedicatedSettings.readable(d) else { return (lastSettings, false) }
    lastSettings = s
    noteDroppedEntries(s)
    return (s, true)
  }

  func fileModel() -> WorkersFile {
    var threads: [String: WorkersFile.Entry] = [:]
    for (id, r) in rt { threads[id] = r.persisted }
    return WorkersFile(
      supervisor: .init(
        pid: getpid(), heartbeat_at: ISOTime.string(now()), workers_supported: true, main_pane_pid: mainPanePid(),
        main_dialog: mainDialogFeed.current(), subthreads_supported: true, subthreads_own_folder: true,
        subthreads_shared_folder: true),
      threads: threads)
  }

  func tmux(_ id: String) -> TmuxCommands {
    TmuxCommands(tmux: options.tmux, socket: options.socket, configPath: options.tmuxConf, session: WorkerSpec.tmuxName(id))
      .withPane(rt[id]?.paneId)
  }

  // MARK: start

  private static let holding: Set<String> = ["starting", "live", "busy", "parking", "stopping"]

  /// Every worker holding a slot, `parking` and `stopping` included: their processes are still running. One waiting on the owner
  /// counts as busy (WorkerOwnerHold.swift): never a victim. That look costs tmux calls, so it is made only when every slot is taken.
  private func liveList(now t: Double, except: String? = nil, maxLive: Int) -> [WorkerPolicy.Live] {
    let full = rt.filter { $0.key != except && Self.holding.contains($0.value.entry.state) }.count >= maxLive
    return rt.compactMap { id, r in
      guard id != except, Self.holding.contains(r.entry.state) else { return nil }
      let onTheWay = r.entry.state != "live" && r.entry.state != "busy"
      let busy = onTheWay || isBusy(id, now: t) || (full && waitsOnOwner(id, now: t))
      // background work is looked for only when a choice is to be made, and only on a quiet one (the look reads the process table)
      let background = full && !busy && (backgroundWork(id)?.count ?? 1) > 0
      // ranked on the awake clock: after the wall clock is set back the wall times stand still, and would rank the session in use first
      return WorkerPolicy.Live(threadId: id, busy: busy, lastActive: r.activeAwake, background: background)
    }
  }

  func requestStart(_ id: String, _ s: ThreadSessionSettings, resume: Bool, _ settings: DedicatedSettings, _ t: Double) {
    // one worker per folder, except the agent folder (main's own; workers there don't touch git, OPTION-C 7.2)
    // a sub-thread that can't start says so before it is asked about folders (it never shares its parent's)
    if refuseUnderNarrowedMain(id) { return }  // before anything else: no slot is taken, and no other session is parked for it
    if refuseWithoutHook(id, cwd: s.cwd) { return }  // a hook that cannot run refuses every start: found before a slot is taken
    if let why = s.sub?.refusal { return fail(id, "start_failed", why) }
    if let sub = s.sub, sub.ownCwd, let p = sub.parentCwd, let r = SubThreadFolder.check(cwd: s.cwd ?? "", parentCwd: p) {
      return fail(id, "start_failed", "sub-thread folder: \(r.why)")  // the parent's own folder is not a subfolder: never a wait for it
    }
    // before the folder claim, so the owner sees the field, not "another session works in <agent folder>"
    if let why = unreadFolderRefusal(id, s) { return fail(id, "start_failed", why) }
    let cwd = s.cwd ?? options.agentDir
    if cwd != options.agentDir, folderClaimed(cwd, by: id, s, settings) {
      fail(id, "folder_claimed", "another thread session works in \(cwd)")
      return
    }
    guard let own = mainSettingsOrRefuse(id) else { return }  // main's own --settings cannot be read: refused before it takes a slot
    switch WorkerPolicy.planStart(live: liveList(now: t, except: id, maxLive: settings.maxLive), maxLive: settings.maxLive) {
    case .start:
      start(id, s, resume: resume, now: t, own: own)
    case .parkThenStart(let victim):
      stopNow(victim, why: "cap")  // its log line, and its thread's line if it cut background work (every quiet one had some)
      emit(.parked(thread: victim, reason: "cap"))
      start(id, s, resume: resume, now: t, own: own)
    case .hold:
      hold(id, resume: resume, now: t)
    }
  }

  /// Keeps a start for the next tick. `heldSince` stays put, so the hold still ends.
  func hold(_ id: String, resume: Bool, now t: Double, unreadable: Bool = false) {
    if rt[id]?.heldSince == nil { rt[id]?.heldSince = t }
    rt[id]?.heldResume = resume
    rt[id]?.heldUnreadable = unreadable
  }

  /// Another session holds the folder, unless it is in the same family: a parent and the dedicated sub-threads that share its folder, and two of
  /// those siblings, may work in it together (the config held now decides). Every other pair is claimed.
  private func folderClaimed(_ cwd: String, by id: String, _ s: ThreadSessionSettings, _ settings: DedicatedSettings) -> Bool {
    let key = WorkerSpec.folderKey(cwd)
    return rt.contains {
      $0.key != id && Self.holding.contains($0.value.entry.state) && WorkerSpec.folderKey($0.value.entry.cwd) == key
        && !SubThreads.sameFamily(s, settings.threads[$0.key])
    }
  }

  /// `folder_claimed` is a moment, not a fault: it clears when the other worker has gone, so the next message starts.
  private func clearFolderClaims(_ settings: DedicatedSettings) {
    for (id, r) in rt where r.entry.state == "failed" && r.entry.error?.code == "folder_claimed" {
      if !folderClaimed(r.entry.cwd, by: id, settings.threads[id] ?? ThreadSessionSettings(threadId: id), settings) {
        rt[id]?.entry.state = "parked"
        rt[id]?.entry.error = nil
        dirty = true
      }
    }
  }

  private func retryHeld(settings: DedicatedSettings, now t: Double) {
    for id in Array(rt.keys) {
      guard let r = rt[id], let since = r.heldSince else { continue }
      guard let s = settings.threads[id] else {
        rt[id]?.heldSince = nil
        continue
      }
      if t - since > options.capHold {
        audit("worker_start_hold_dropped thread=\(id) after_s=\(Int(t - since)) unreadable=\(r.heldUnreadable)")
        if r.heldUnreadable {
          // tmux could not be read for the whole wait: the session was not started, and that is said where the owner sees every other
          // start that failed (an update restart then counts it as failed, not as quietly not restarted)
          rt[id]?.heldUnreadable = false
          fail(id, "start_failed", "tmux could not be read for \(Int(t - since)) s, so the session was not started")
          continue
        }
        // every slot stayed busy: drop it; the hub's deadline hands the message to main (worker_cap)
        rt[id]?.heldSince = nil
        rt[id]?.pendingPointer = false
        continue
      }
      if case .hold = WorkerPolicy.planStart(live: liveList(now: t, except: id, maxLive: settings.maxLive), maxLive: settings.maxLive) { continue }
      requestStart(id, s, resume: r.heldResume, settings, t)
    }
  }

  /// A lowered `max_live`, or more adopted workers than the cap: the longest-idle go first; busy ones wait, and so do ones with
  /// background work while a quiet one without is there (`WorkerPolicy.victims`). A worker on its way out has already made its room:
  /// counted here, each tick would pick one more until nobody was left.
  private func enforceCap(settings: DedicatedSettings, now t: Double) {
    let staying = liveList(now: t, maxLive: settings.maxLive).filter { WorkersFile.liveStates.contains(rt[$0.threadId]?.entry.state ?? "") }
    let excess = staying.count - settings.maxLive
    guard excess > 0 else { return }
    for v in WorkerPolicy.victims(staying).prefix(excess) { beginPark(v.threadId, reason: "cap") }
  }

  static func nonce() -> String {
    (0..<16).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
  }

  /// What's in the tmux session name this thread would use. A read that fails is `.unknown`, never "free".
  /// `unknown` carries what the failed read said, for the audit line of the hold it causes.
  private enum SessionName { case free, deadLeftover, running, unknown(String) }

  private func sessionName(_ id: String) -> SessionName {
    let t = tmux(id).withPane(nil)
    let session = run(t.hasSession())
    guard session.ok else {
      return TmuxCommands.saysGone(status: session.status, stderr: session.err, timedOut: session.timedOut)
        ? .free : .unknown("has-session status=\(session.status) timed_out=\(session.timedOut) err=\"\(WorkerNotice.logValue(String(session.err.prefix(160))))\"")
    }
    let read = run(t.paneState())
    guard read.ok, let old = TmuxCommands.parsePaneState(read.out) else {
      return .unknown("pane_state status=\(read.status) timed_out=\(read.timedOut) out=\"\(WorkerNotice.logValue(String(read.out.prefix(160))))\" err=\"\(WorkerNotice.logValue(String(read.err.prefix(160))))\"")
    }
    return old.dead ? .deadLeftover : .running
  }

  private func start(_ id: String, _ s: ThreadSessionSettings, resume: Bool, now t: Double, own: MainOwnSettings) {
    guard var r = rt[id], !refuseUnderNarrowedMain(id) else { return }  // the last word: nothing is made under a narrowed Main
    guard let folder = startFolder(id, s) else { return }
    let cwd = folder.cwd
    // The login shell has not been read yet (it failed, or is slow), so the PATH may be the app's bare one. A claude that is not on
    // it would exit at once and the thread would crash-loop: keep the start for a later tick, when a retry may have answered.
    // The environment is asked for first: that is what waits for the first read.
    if let has = hasLoginEnv, LoginShellEnv.which(options.claudePath, path: baseEnv()["PATH"], isExecutable: probe.isExecutable) == nil,
      !has()
    {
      if rt[id]?.heldSince == nil { audit("worker_start_held thread=\(id) reason=login_env_unreadable_and_claude_not_on_path") }
      return hold(id, resume: resume, now: t)
    }
    // before anything is written: a refused start leaves no launch script, and a running worker keeps its nonce
    switch sessionName(id) {
    case .free: break
    case .deadLeftover: _ = run(tmux(id).withPane(nil).killSession())  // reuse the name only when its pane is dead
    case .running:
      // this thread's own worker that this copy does not own (WorkerStray.swift): stopped, and the start goes on
      guard stopStrayWorker(id) else { return fail(id, "start_failed", "a session for this thread is already running in tmux") }
      r = rt[id] ?? r
    case .unknown(let said):
      if rt[id]?.heldSince == nil { audit("worker_start_held thread=\(id) reason=tmux_session_unreadable \(said)") }  // said once per hold, like the other holds
      return hold(id, resume: resume, now: t, unreadable: true)
    }
    closeNoticeRecord(id)  // a new start has no dialog open
    guard let hook = installHook(id, cwd: cwd, resume: resume, now: t) else { return }  // the copy this session runs, made now; refused when it cannot be
    let base = baseEnv()
    let claudeDir = WorkerMcp.claudeDir(home: options.home, env: base)
    let main = mainCeiling(own, claudeDir: claudeDir)  // from this start's one read of main's own --settings (WorkerMainSettings.swift)
    var plan: WorkerMcp.Plan?
    if let allow = s.mcpAllow {
      plan = WorkerMcp.plan(
        allow: allow, agentDir: options.agentDir, cwd: cwd, home: options.home, claudeDir: claudeDir, talosHome: options.talosHome,
        threadId: id, configDirSet: WorkerMcp.configDirSet(env: base))
      if plan == nil { return fail(id, "start_failed", "the MCP list needs a talos-app server in the agent folder's .mcp.json") }
    } else if let why = removeListConfig(id) {
      return fail(id, "start_failed", why)
    }
    let sessionId = (resume ? r.entry.session_id : nil) ?? UUID().uuidString.lowercased()
    // Main's rule (`Supervisor.launchLocked`): Claude Code saves a conversation only after its first message or an /exit, so a
    // session nobody typed in has no file and `--resume` of it is refused ("No conversation found"), which left the thread
    // `resume_missing`. It is the same session started again: `--session-id <the same id>`. The file is looked for in the
    // session's own config folder (`SessionTranscript.find`); an id the CLI refused as already in use is resumed whatever the look says.
    // Only for a session that never had a turn (`Entry.hadTurn`): one a message was typed into has a conversation, and a file that
    // is not found then is lost (deleted, another config folder), not unsaved. That one is resumed, so the thread ends
    // `resume_missing` with the owner's Start fresh, never quietly empty under the same id.
    let unsaved = resume && !r.entry.hadTurn && r.resumeAnyway != sessionId
      && !SessionTranscript.isSaved(sessionId: sessionId, folder: cwd, claudeDir: claudeDir)
    let resumes = resume && !unsaved
    let nonce = Self.nonce()
    seedThreadState(id, name: s.name)
    let d = dir(id)
    let launch = d + "/launch.sh"
    try? FileManager.default.createDirectory(
      atPath: WorkerSpec.noChannelDir(talosHome: options.talosHome), withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    unlink(d + "/ready")
    // restart on update: the launch spec's hash, kept in the launch record with the spec an update restart last tried (WorkerLaunchPlan.swift)
    var specHash: String?
    var instructionsHash: String?
    do {
      let talosOnly = plan == nil ? talosOnlyMcp(id, cwd: cwd) : nil
      let written = talosOnly.flatMap { (try? AtomicFile.write($0.bytes, to: $0.path, mode: 0o600)) != nil ? $0 : nil }
      let spec = try WorkerSpec.build(
        specInputs(
          id, s, cwd: cwd, parent: folder.parent, hook: hook, main: main, plan: plan, mcpConfigPath: written?.path, sessionId: sessionId,
          resume: resumes, nonce: nonce, base: base, threadFence: threadFenceForStart(id, dry: false)))
      let parts = launchSpecParts(spec: spec, plan: plan, talosOnly: written?.bytes, hook: hook, base: base)
      specHash = parts.hash
      instructionsHash = Self.instructionsHash(spec, parts)
      if let plan { try WorkerMcp.write(plan) }
      try AtomicFile.write(Data(spec.settingsJSON.utf8), to: WorkerSpec.settingsPath(talosHome: options.talosHome, threadId: id))
      try AtomicFile.write(Data(nonce.utf8), to: d + "/nonce", mode: 0o600)
      unlink(launch)  // one an interrupted start left
      try LaunchFile.create(at: launch, script: spec.launchScript())
    } catch WorkerSpec.BuildError.escalation(let denial) {
      // wider than main: not launched, and the thread is told once
      unlink(launch)
      fail(id, PrivilegeCeiling.code, denial.detail, axis: denial.axis.rawValue)
      tell(id, slot: \.ceilingNote, kind: "ceiling: \(denial.axis.rawValue)", LaunchChange.ceilingLine(denial))
      return
    } catch {
      unlink(launch)
      fail(id, "start_failed", "\(error)")
      return
    }
    if unsaved { audit("\(SessionTranscript.notSavedEvent) thread=\(id) session=\(sessionId)") }
    // on disk before tmux makes it: an app that goes in between leaves "starting", which the next launch takes back (WorkerStray.swift)
    rt[id]?.entry.state = "starting"
    rt[id]?.entry.pane_pid = 0
    rt[id]?.entry.started_at = ISOTime.string(t)
    let launched = WorkersFile.Launched(
      cwd: cwd, model: s.model, effort: s.effort, mcp_allow: s.mcpAllow, spec_hash: specHash, update_tried_hash: r.entry.launched?.update_tried_hash,
      instructions_hash: instructionsHash)
    rt[id]?.entry.launched = launched  // a spec tried stays tried
    writeFile()
    let create = tmux(id).withPane(nil).newSession(argv: LaunchFile.tmuxArgv(launch), cwd: cwd)
    var res = run(create)
    // The previous worker's session may have been the last one on this socket: a server on its way out answers "server
    // exited unexpectedly" and creates nothing, so the owner's Start fresh would fail for no reason. Ask again (bounded).
    for _ in 0..<3 where TmuxCommands.saysServerWentAway(status: res.status, stderr: res.err, timedOut: res.timedOut) {
      res = run(create)
    }
    let pane = res.out.trimmingCharacters(in: .whitespacesAndNewlines)
    // a timeout says nothing about whether tmux made the session: `advance` finds out, the same as after a failed read
    guard res.timedOut || (res.ok && TmuxCommands.isPaneId(pane)) else {
      unlink(launch)
      fail(id, "start_failed", "tmux: \(res.err.prefix(200))")
      return
    }
    r.paneId = TmuxCommands.isPaneId(pane) ? pane : nil
    r.pgid = 0
    r.startedAt = t
    r.startedAwake = awake()
    r.readyAt = 0
    r.lastActive = t
    r.activeAwake = r.startedAwake
    r.parkDeadline = nil
    r.parkReason = nil
    r.stopDeadline = nil
    r.afterPark = nil
    r.heldSince = nil
    r.heldUnreadable = false
    r.enterOwed = false
    r.seenActivity = nil
    r.activityChangedAwake = nil
    r.forgetScreen()
    r.startedAsResume = resumes
    r.entry.state = "starting"
    r.entry.session_id = sessionId
    r.entry.pane_pid = 0
    r.entry.cwd = cwd
    r.entry.model = s.model
    // `mcp_allow` here is the list as configured, names that were not found included: it is compared with the config, not with the file
    r.entry.launched = launched
    r.entry.started_at = ISOTime.string(t)
    r.entry.parked_at = nil
    r.entry.error = nil
    r.entry.clearStatusFields()
    rt[id] = r
    dirty = true
    emit(.started(thread: id, resume: resumes))
    noteLaunch(id, missing: plan?.missing ?? [], refused: plan?.refused ?? [], ownFolder: plan?.ownFolder ?? [:])
    _ = claimPane(id)
  }

  /// Takes ownership of the pane `start` just made. A failed read leaves the worker `starting` with no group yet, and
  /// `advance` tries again: reporting "exited at once" on a failed read would leave it running, failed and unowned.
  private func claimPane(_ id: String) -> Pane {
    let read = run(tmux(id).paneState())
    if read.ok, let ps = TmuxCommands.parsePaneState(read.out) {
      if ps.dead { return .gone(rows: lastRows(id)) }
      guard let pid = ps.pid, let snap = probe.snapshot(pid) else { return .unknown }
      signaller.own(pid, leaderStart: snap.startTime)
      rt[id]?.pgid = pid
      rt[id]?.entry.pane_pid = pid
      rt[id]?.paneId = ps.paneId ?? rt[id]?.paneId
      dirty = true
      return .running(ps)
    }
    let session = run(tmux(id).hasSession())
    return TmuxCommands.saysGone(status: session.status, stderr: session.err, timedOut: session.timedOut)
      ? .gone(rows: []) : .unknown
  }

  // MARK: per-tick progress

  private enum Pane {
    case running(TmuxCommands.PaneState)
    /// tmux says it's gone (or it's no longer ours). `rows`: its last screen, when it can still be read.
    case gone(rows: [String])
    /// A failed read says nothing: never a reason to touch a worker.
    case unknown
  }

  private func lastRows(_ id: String) -> [String] {
    let c = run(tmux(id).captureRecent(lines: 40))
    return c.ok ? TmuxCommands.parseCapture(c.out) : []
  }

  private func pane(_ id: String, group: Int32) -> Pane {
    let read = run(tmux(id).paneState())
    if read.ok, let ps = TmuxCommands.parsePaneState(read.out) {
      if ps.dead { return .gone(rows: lastRows(id)) }
      // pane ids restart with a new tmux server: this id may name someone else's pane now
      return ps.pid == group ? .running(ps) : .gone(rows: [])
    }
    let session = run(tmux(id).hasSession())
    if TmuxCommands.saysGone(status: session.status, stderr: session.err, timedOut: session.timedOut) { return .gone(rows: []) }
    // tmux can't say. The kernel can: a group with nothing left in it has gone, whatever tmux would have answered.
    return signaller.alive(group) ? .unknown : .gone(rows: [])
  }

  /// Unknown counts as busy: only a pane read as quiet may be parked or chosen as the cap's victim.
  func isBusy(_ id: String, now t: Double) -> Bool {
    guard let r = rt[id], r.pgid > 0 else { return true }
    let read = run(tmux(id).paneState())
    guard read.ok, let ps = TmuxCommands.parsePaneState(read.out), !ps.dead, ps.pid == r.pgid else { return true }
    return readsBusy(id, ps, now: t)
  }

  /// Quiet by the wall clock alone isn't quiet: straight after a sleep or a clock change, a turn that was printing looks
  /// silent for hours. It must also have been silent for the busy window on the awake clock.
  private func readsBusy(_ id: String, _ ps: TmuxCommands.PaneState, now t: Double) -> Bool {
    guard let a = ps.activity else { return true }
    let w = awake()
    if rt[id]?.seenActivity != a { rt[id]?.activityChangedAwake = w }  // a first sighting counts: adopt seeds its own
    rt[id]?.seenActivity = a
    if t - a < options.busyWindow { return true }
    if let changed = rt[id]?.activityChangedAwake, w - changed < options.busyWindow { return true }
    return false
  }

  /// The line about a turn cut after a relaunch: sent, and tried again each tick while a clear failure leaves it unsent.
  private func tellCut(_ id: String) {
    guard let line = rt[id]?.cutLine else { return }
    sendNotice(id, \.cutNote, kind: WorkerNotice.turnCutKind, text: line)
    if rt[id]?.cutNote.sent == true { rt[id]?.cutLine = nil }
  }

  private func advance(_ id: String, settings: DedicatedSettings, now t: Double) {
    guard var r = rt[id], !r.adoptPending else { return }
    tellCut(id)
    tellBackgroundCut(id)
    switch r.entry.state {
    case "starting", "live", "busy", "stopping":
      let ps: TmuxCommands.PaneState
      switch r.pgid > 0 ? pane(id, group: r.pgid) : claimPane(id) {
      case .unknown: return
      case .gone(let rows): return exited(id, rows: rows, settings: settings, now: t)
      case .running(let p): ps = p
      }
      guard let current = rt[id] else { return }
      r = current
      // no screen, no decision: a failed capture is not an empty screen
      let capture = run(tmux(id).capturePane())
      guard capture.ok else { return }
      let rows = TmuxCommands.parseCapture(capture.out)
      let scr = DialogMatcher.workerScreen(rows)
      // A worker's screen is a conversation (a resumed one too), and it may quote any dialog's words. Only a whole dialog (its
      // frame, its phrase, numbered options, at the bottom of the screen) that has held still for `dialogSettle` is one. `scr`,
      // by words alone, only keeps the typing guard careful.
      if rt[id]?.screenText != capture.out {
        rt[id]?.screenText = capture.out
        rt[id]?.screenSameSince = awake()
        noteScreenChanged(id)  // a dialog on offer may have been replaced by one that reads the same
      }
      let still = awake() - (rt[id]?.screenSameSince ?? awake()) >= options.dialogSettle
      let seen: DialogMatcher.Screen = still ? DialogMatcher.liveDialog(rows) : .none
      noteComputerUse(id, rows: rows)  // not held to `dialogSettle`: the spinner above it never stops while it waits
      noteUsageLimit(id, rows: rows)  // the same, and never a key
      noteScreens(id, rows: rows, seen: seen, settled: still)
      answerDialog(id)  // a tap's answer for the dialog just noted (WorkerDialogAnswer.swift)
      r = rt[id] ?? r
      if r.entry.state == "starting" {
        // A screen never to be answered (the usage limit, a computer-use dialog its Escape did not clear) is not a start to fail as
        // `needs_mac` ("answer it there"): the session waits on the owner's Esc, with that kind's own line, and the ready timeout waits too.
        if let held = r.needsYouPrompt, DialogMatcher.Screen.answerless(label: held) {
          rt[id]?.startedAwake = awake()
          return
        }
        if let waiting = seen.isDialog ? seen.label : r.promptWatch.current.map({ $0.title ?? "prompt" }) {
          // Workers have no dialog by design; one here (trust, MCP consent, login) needs the owner. The pane stays up so the
          // owner can answer it in the Terminals window (or with a tap); nothing else is typed. The ready timeout waits while it is on screen. A
          // dialog nobody answers for `dialogLimit` stops the worker as `needs_mac`, as before.
          if let since = r.dialogSinceAwake, awake() - since > options.dialogLimit {
            stopNow(id, why: "crash")  // the session could not go on by itself (its `needs_mac` error says why), not the owner's stop
            return fail(id, "needs_mac", waiting)
          }
          rt[id]?.startedAwake = awake()
          return
        }
        if FileManager.default.fileExists(atPath: dir(id) + "/ready") {
          unlink(dir(id) + "/launch.sh")
          r.entry.state = "live"
          r.gaveNewId = false
          r.readyAt = t
          r.markActive(wall: t, awake: awake())
          rt[id] = r
          dirty = true
          emit(.live(thread: id))
        } else if awake() - r.startedAwake > options.readyTimeout {
          stopNow(id, why: "crash")  // a start that never came up: its `start_failed` error says why
          return fail(id, "start_failed", "the session never connected to Talos")
        } else {
          return
        }
      }
      noteScreen(&r, rows: rows, now: t)
      rt[id] = r
      let busy = readsBusy(id, ps, now: t)
      if !busy { noteTurnEnded(id, now: t) }
      if r.entry.state == "stopping" {
        // here, after the pane and the screen were read: a failed read never gets this far
        if !busy {
          beginPark(id, reason: r.parkReason ?? "control")
        } else if let limit = r.stopDeadline, awake() >= limit {
          if r.stopAdopted {
            // the one stop that cuts a turn nobody at the Mac tapped for: said in the thread, once (`tellCut`)
            rt[id]?.cutNote.reset()
            rt[id]?.cutLine = WorkerNotice.turnCutLine(limit: options.adoptedStopLimit)
            tellCut(id)
          }
          beginPark(id, reason: "stop_limit")
        }
        return
      }
      let next = busy ? "busy" : "live"
      if r.entry.state != next { dirty = true }
      r.entry.state = next
      rt[id]?.entry.state = next
      if !r.pendingPointer { noteHeldPointer(id, .none) }
      if r.pendingPointer, typeOwedPointer(id, rows: rows, screen: scr, now: t) { return }
      let idle = options.idleSecondsOverride ?? Double((settings.threads[id]?.idleParkMin ?? 30) * 60)
      // a worker waiting on the owner is not parked for being quiet: the answer is what it is waiting for. A dialog on screen that has
      // not held still for `dialogSettle` yet is not flagged, but it waits on the owner all the same (as `waitsOnOwner` reads it).
      // and never while background work runs under it (a Bash tool command, a waiter): the park would kill it (WorkerBackground.swift)
      if !busy, !r.pendingPointer, r.needsYouPrompt == nil, awake() - r.activeAwake >= idle, guardShape(rows) == .none,
        idleLimitPassed(id, idle: idle), idleFreeOfBackgroundWork(id)
      {
        beginPark(id, reason: "idle")
      }
    case "parking":
      // until the whole group is gone, not just the pane: a child that ignored SIGTERM must not outlive "parked"
      if r.pgid <= 0 || !signaller.alive(r.pgid) {
        finishPark(id, settings: settings, now: t)
      } else if let dl = r.parkDeadline, awake() > dl {
        signaller.signal(r.pgid, SIGKILL)
        finishPark(id, settings: settings, now: t)
      }
    default:
      return
    }
  }

  func fail(_ id: String, _ code: String, _ detail: String, axis: String? = nil) {
    if rt[id] == nil { return }
    rt[id]?.entry.state = "failed"
    rt[id]?.entry.error = .init(code: code, detail: WorkersFile.ErrorInfo.clipDetail(detail), at: ISOTime.string(now()), axis: axis)
    rt[id]?.folderChangeTo = nil
    rt[id]?.pendingPointer = false
    rt[id]?.afterPark = nil
    rt[id]?.heldSince = nil
    dirty = true
    emit(.failed(thread: id, code: code))
  }
}
