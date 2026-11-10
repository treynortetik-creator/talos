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
    /// Main's real launch arguments from desktop.json. Its permission mode is worked out from these (`--permission-mode X` as well as
    /// `--dangerously-skip-permissions`); empty = just `permissionFlag`.
    public var mainArgs: [String] = []
    /// Where to write one line for every MCP server of a thread's own folder that a session is started with (nil = nowhere).
    public var auditLogPath: String?
    public var tmux: String
    public var socket: String = TmuxCommands.defaultSocket
    public var tmuxConf: String
    /// The owner's home folder, for the folder re-check before each start.
    public var home: String = NSHomeDirectory()
    public var tick: Double = 1
    public var heartbeat: Double = 5
    public var readyTimeout: Double = 90
    public var parkGrace: Double = 5
    public var capHold: Double = 120
    /// Output newer than this marks a worker busy (no parking, no cap victim).
    public var busyWindow: Double = 15
    /// How long an owner's stop waits for the turn to end, from the tap. On the awake clock. 15 min outlasts any single tool
    /// (the Bash tool's ceiling is 10) and 98.9 % of the turns measured on this owner's sessions.
    public var stopLimit: Double = 900
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
    var lastActive: Double = 0
    /// The screen above the input box's lower rule at the last tick (`WorkerActivity.body`); nil before the first look.
    var body: String?
    var pendingPointer = false { didSet { if !pendingPointer { owed = OwedState() } } }  // nothing owed, nothing left of its hold
    var owed = OwedState()  // the deadline of that pointer, and how a relaunch settles it (WorkerOwedPointer.swift)
    /// On the awake clock.
    var parkDeadline: Double?
    /// An owner's stop gives up waiting for the turn at this time, on the awake clock. Memory only: an adopted `stopping`
    /// worker has none until the next tap, because it might be the governor's.
    var stopDeadline: Double?
    var parkReason: String?
    /// A `restart`, `fresh` or `resume` that arrived while the worker was on its way out: run when it's gone.
    var afterPark: String?
    var restartTimes: [Double] = []
    /// A start waiting for a free slot (`hold`), and since when.
    var heldSince: Double?
    var heldResume = false
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
    /// When (awake clock) the current dialog was first seen.
    var dialogSinceAwake: Double?
    var dialogAbsence = DialogAbsence()  // awake clock: since the pane showed no dialog shape at all; clears a held flag (noteScreens)
    /// The notice for the dialog on screen now (`dlg`), for a pointer held back by a draft (`held`) or by no input box (`noBox`).
    var dlg = NoticeState()
    var held = NoticeState()
    var noBox = NoBoxHold()
    /// Since when (awake clock) the pointer has been held by text in Claude's input box; nil when it isn't.
    var draftSince: Double?
    /// Whether this worker's notice records were checked against its screen since this copy of the app took it over.
    var recordsChecked = false
    /// The last screen text read and since when (awake clock): a dialog counts once the screen has held still.
    var screenText: String?
    var screenSameSince: Double = 0
    /// Prompts nobody named: the one announced, and its stillness (`PromptDetector`).
    var promptWatch = PromptWatch()
    /// The tap-answerable dialog on the pane: since when it was offered, which answers were taken (WorkerDialogOffer.swift).
    var offer = OfferState()
    /// A change to what the session was launched with, waiting out its settle time (WorkerLaunchChange.swift).
    var change = LaunchChange.Debounce()
    /// The folder a fresh restart is for: the thread is told about it once the new session has started.
    var folderChangeTo: String?
    /// The lines about the launch: a new folder, MCP servers not found, a refused spec. `fenceKinds` is the kind each slot last told.
    var folderNote = NoticeState()
    var missingNote = NoticeState()
    var refusedNote = NoticeState()
    var ceilingNote = NoticeState()
    var fenceKinds: [AnyHashable: String] = [:]
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
  public var onEvent: (@Sendable (Event) -> Void)?
  /// Posts one plain line into a thread through the bridge (`talos-app post <thread> <text>`). Blocking; called off the worker
  /// queue. `talos-app post` takes no message key, so a timeout (`unknown`) is never retried: it may have been sent. nil = this build can't post (the notice then shows only in the Mac app).
  public var postNotice: (@Sendable (_ thread: String, _ text: String) -> PostOutcome)?
  /// Brings the Terminals window to a thread (a tap on "Open on the Mac"); false when no window can be shown.
  public var openTerminals: (@Sendable (_ thread: String) -> Bool)?
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
  private var timer: DispatchSourceTimer?
  var rt: [String: Runtime] = [:]
  private var adopted = false
  private var lastHeartbeat: Double = 0
  var dirty = false
  /// nil until a config has been read: not knowing the settings is not the same as "off".
  private var lastSettings: DedicatedSettings?
  private var stopped = false
  private var lockFd: Int32 = -1
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

  public func startTicking() {
    queue.async {
      self.stopped = false
      guard self.timer == nil else { return }
      let t = DispatchSource.makeTimerSource(queue: self.queue)
      t.schedule(deadline: .now(), repeating: self.options.tick)
      t.setEventHandler { [weak self] in self?.tickLocked() }
      self.timer = t
      t.resume()
    }
  }

  /// Stops ticking. Workers keep running in tmux; the next launch re-adopts them from workers.json.
  public func detach() {
    queue.sync {
      timer?.cancel()
      timer = nil
      releaseLock()
    }
  }

  /// "Quit and stop": stops ticking, drops everything waiting, stops every worker now and leaves them parked, so nothing
  /// runs or starts with no supervisor. A passive copy runs nothing, so it stops nothing and writes nothing.
  public func stopAll() {
    queue.sync {
      defer { publish() }
      timer?.cancel()
      timer = nil
      stopped = true
      guard lockFd >= 0 else { return }
      for id in Array(rt.keys) {
        rt[id]?.heldSince = nil
        rt[id]?.pendingPointer = false
        rt[id]?.afterPark = nil
        if rt[id]?.adoptPending == true { adoptOne(id, now: now()) }  // what still can't be read stays for the next launch
      }
      for (id, r) in rt where r.pgid > 0 || r.paneId != nil { stopNow(id) }
      writeFile()
    }
  }

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

  private func releaseLock() {
    guard lockFd >= 0 else { return }
    // close() alone leaves the flock held while any copy of the open file description lives (a spawn in flight holds one until
    // exec), so the next manager's tryLock would fail. Unlock first, as Supervisor.releaseLock does.
    flock(lockFd, LOCK_UN)
    close(lockFd)
    lockFd = -1
  }

  private func tickLocked() {
    defer { publish() }
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
    let settings = loadSettings()
    if !adopted {
      adopt(now: t)
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
        }
      }
    }
    for id in Array(rt.keys) {
      advance(id, settings: settings ?? .off, now: t)
      publish()  // a long tick shows its progress
    }
    if let settings {
      reviveOwed(settings: settings, now: t)
      takeWakes(settings: settings, now: t)
      publish()
      retryHeld(settings: settings, now: t)
      enforceCap(settings: settings, now: t)
      checkLaunchChanges(settings: settings, now: t)
    }
    clearFolderClaims()
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
  func loadSettings() -> DedicatedSettings? {
    if let d = FileManager.default.contents(atPath: configJson), let s = DedicatedSettings.readable(d) { lastSettings = s }
    return lastSettings
  }

  func fileModel() -> WorkersFile {
    var threads: [String: WorkersFile.Entry] = [:]
    for (id, r) in rt { threads[id] = r.persisted }
    return WorkersFile(
      supervisor: .init(
        pid: getpid(), heartbeat_at: ISOTime.string(now()), workers_supported: true, main_pane_pid: mainPanePid(),
        main_dialog: mainDialogFeed.current()),
      threads: threads)
  }

  func writeFile() {
    do {
      try AtomicFile.write(try fileModel().encoded(), to: workersJson, mode: 0o600)
    } catch {
      // the next tick tries again; the hub reads a stale heartbeat as "supervisor down" and main answers meanwhile
    }
  }

  func tmux(_ id: String) -> TmuxCommands {
    TmuxCommands(tmux: options.tmux, socket: options.socket, configPath: options.tmuxConf, session: WorkerSpec.tmuxName(id))
      .withPane(rt[id]?.paneId)
  }

  func run(_ argv: [String]) -> RunResult { ProcessRunner.run(argv, env: baseEnv(), timeout: 10) }

  // MARK: adopt (app relaunch)

  private func adopt(now t: Double) {
    guard let d = FileManager.default.contents(atPath: workersJson), let f = WorkersFile.decode(d) else { return }
    for (id, e) in f.threads where WorkerSpec.isThreadId(id) {
      var r = Runtime(entry: e)
      r.restoreOwed()
      r.restartTimes = e.restarts.compactMap(ISOTime.parse)
      r.adoptPending = !WorkersFile.restingStates.contains(e.state)
      rt[id] = r
      if r.adoptPending { adoptOne(id, now: t) }
    }
    dirty = true
  }

  /// Decides one worker from the file. Anything that can't be read leaves it pending, untouched, for the next tick: a
  /// worker marked parked on a failed read would run on, unowned and outside the cap, with no way back from the app.
  private func adoptOne(_ id: String, now t: Double) {
    guard var r = rt[id] else { return }
    let e = r.entry
    func notRunning() {
      r.adoptPending = false
      r.entry.state = "parked"
      r.entry.pane_pid = 0
      r.entry.parked_at = r.entry.parked_at ?? ISOTime.string(t)
      rt[id] = r
      dirty = true
    }
    let session = run(tmux(id).hasSession())
    guard session.ok else {
      if TmuxCommands.saysGone(status: session.status, stderr: session.err, timedOut: session.timedOut) { notRunning() }
      return
    }
    let read = run(tmux(id).paneState())
    guard read.ok, let ps = TmuxCommands.parsePaneState(read.out) else { return }
    if ps.dead { return notRunning() }
    guard let pid = ps.pid, let snap = probe.snapshot(pid) else { return }
    if snap.pgid == pid, WorkerSpec.argvLooksLikeMain(snap.argv) {
      // spec 4.4: channels on a worker pane's command line is a bug: stop it, whatever the file says
      signaller.own(pid, leaderStart: snap.startTime)
      rt[id]?.adoptPending = false
      rt[id]?.pgid = pid
      rt[id]?.paneId = ps.paneId
      stopNow(id)
      return
    }
    guard pid == e.pane_pid, e.pane_pid > 1, snap.pgid == e.pane_pid else { return notRunning() }
    // still ours: same pane pid, its own group, a worker's argv
    signaller.own(e.pane_pid, leaderStart: snap.startTime)
    r.adoptPending = false
    r.pgid = e.pane_pid
    r.paneId = ps.paneId
    r.startedAt = e.started_at.flatMap(ISOTime.parse) ?? t
    r.startedAwake = awake()
    r.readyAt = e.state == "starting" ? 0 : r.startedAt
    r.seenActivity = ps.activity
    // the clock carries on: a relaunch buys no extra idle time (spec 3.5). The file's times, never the pane's own output.
    let saved = e.last_active_at.flatMap(ISOTime.parse).map { min($0, t) }  // a time in the future is no later than now
    r.lastActive = [saved, e.last_turn_at.flatMap(ISOTime.parse), r.startedAt].compactMap { $0 }.max() ?? t
    if e.state == "parking" { r.parkDeadline = awake() + options.parkGrace }
    // a state this build doesn't know: it runs, and that is all that's known
    if !WorkersFile.liveStates.contains(e.state), e.state != "parking", e.state != "stopping" { r.entry.state = "live" }
    rt[id] = r
    dirty = true
  }

  // MARK: start

  private static let holding: Set<String> = ["starting", "live", "busy", "parking", "stopping"]

  /// Every worker holding a slot, `parking` and `stopping` included: their processes are still running.
  private func liveList(now t: Double, except: String? = nil) -> [WorkerPolicy.Live] {
    rt.compactMap { id, r in
      guard id != except, Self.holding.contains(r.entry.state) else { return nil }
      let onTheWay = r.entry.state != "live" && r.entry.state != "busy"
      return WorkerPolicy.Live(threadId: id, busy: onTheWay || isBusy(id, now: t), lastActive: r.lastActive)
    }
  }

  func requestStart(_ id: String, _ s: ThreadSessionSettings, resume: Bool, _ settings: DedicatedSettings, _ t: Double) {
    // one worker per folder, except the agent folder (main's own; workers there don't touch git, OPTION-C 7.2)
    let cwd = s.cwd ?? options.agentDir
    if cwd != options.agentDir, folderClaimed(cwd, by: id) {
      fail(id, "folder_claimed", "another thread session works in \(cwd)")
      return
    }
    switch WorkerPolicy.planStart(live: liveList(now: t, except: id), maxLive: settings.maxLive) {
    case .start:
      start(id, s, resume: resume, now: t)
    case .parkThenStart(let victim):
      stopNow(victim)
      emit(.parked(thread: victim, reason: "cap"))
      start(id, s, resume: resume, now: t)
    case .hold:
      hold(id, resume: resume, now: t)
    }
  }

  /// Keeps a start for the next tick. `heldSince` stays put, so the hold still ends.
  private func hold(_ id: String, resume: Bool, now t: Double) {
    if rt[id]?.heldSince == nil { rt[id]?.heldSince = t }
    rt[id]?.heldResume = resume
  }

  private func folderClaimed(_ cwd: String, by id: String) -> Bool {
    let key = WorkerSpec.folderKey(cwd)
    return rt.contains { $0.key != id && Self.holding.contains($0.value.entry.state) && WorkerSpec.folderKey($0.value.entry.cwd) == key }
  }

  /// `folder_claimed` is a moment, not a fault: it clears when the other worker has gone, so the next message starts.
  private func clearFolderClaims() {
    for (id, r) in rt where r.entry.state == "failed" && r.entry.error?.code == "folder_claimed" {
      if !folderClaimed(r.entry.cwd, by: id) {
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
        // every slot stayed busy: drop it; the hub's deadline hands the message to main (worker_cap)
        rt[id]?.heldSince = nil
        rt[id]?.pendingPointer = false
        continue
      }
      if case .hold = WorkerPolicy.planStart(live: liveList(now: t, except: id), maxLive: settings.maxLive) { continue }
      requestStart(id, s, resume: r.heldResume, settings, t)
    }
  }

  /// A lowered `max_live`, or more adopted workers than the cap: the longest-idle go first; busy ones wait. A worker on its
  /// way out has already made its room: counted here, each tick would pick one more until nobody was left.
  private func enforceCap(settings: DedicatedSettings, now t: Double) {
    let staying = liveList(now: t).filter { WorkersFile.liveStates.contains(rt[$0.threadId]?.entry.state ?? "") }
    let excess = staying.count - settings.maxLive
    guard excess > 0 else { return }
    let idle = staying.filter { !$0.busy }.sorted { ($0.lastActive, $0.threadId) < ($1.lastActive, $1.threadId) }
    for v in idle.prefix(excess) { beginPark(v.threadId, reason: "cap") }
  }

  static func nonce() -> String {
    (0..<16).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
  }

  /// What's in the tmux session name this thread would use. A read that fails is `.unknown`, never "free".
  private enum SessionName { case free, deadLeftover, running, unknown }

  private func sessionName(_ id: String) -> SessionName {
    let t = tmux(id).withPane(nil)
    let session = run(t.hasSession())
    guard session.ok else {
      return TmuxCommands.saysGone(status: session.status, stderr: session.err, timedOut: session.timedOut) ? .free : .unknown
    }
    let read = run(t.paneState())
    guard read.ok, let old = TmuxCommands.parsePaneState(read.out) else { return .unknown }
    return old.dead ? .deadLeftover : .running
  }

  private func start(_ id: String, _ s: ThreadSessionSettings, resume: Bool, now t: Double) {
    guard var r = rt[id] else { return }
    let wanted = s.cwd ?? options.agentDir
    // the worker runs in the resolved folder
    let cwd = realpath(wanted, nil).map { p -> String in
      defer { free(p) }
      return String(cString: p)
    } ?? wanted
    // the bridge checked this folder when it was set; it may have become a symlink since (docs/OPTION-C.md). The value
    // used is a value checked.
    if wanted != options.agentDir {
      for path in [wanted, cwd] {
        if let why = WorkerSpec.folderProblem(path, home: options.home, talosHome: options.talosHome) {
          return fail(id, "start_failed", "thread folder: \(why)")
        }
      }
    }
    // before anything is written: a refused start leaves no launch script, and a running worker keeps its nonce
    switch sessionName(id) {
    case .free: break
    case .deadLeftover: _ = run(tmux(id).withPane(nil).killSession())  // reuse the name only when its pane is dead
    case .running: return fail(id, "start_failed", "a session for this thread is already running in tmux")
    case .unknown: return hold(id, resume: resume, now: t)
    }
    closeNoticeRecord(id)  // a new start has no dialog open
    let claudeDir = WorkerMcp.claudeDir(home: options.home, env: baseEnv())
    // the guards' file is main's --settings unless main's own arguments carry one (then the guards are not active for main)
    let guardsOff = options.mainArgs.contains { $0 == "--settings" || $0.hasPrefix("--settings=") }
    var plan: WorkerMcp.Plan?
    if let allow = s.mcpAllow {
      plan = WorkerMcp.plan(
        allow: allow, agentDir: options.agentDir, cwd: cwd, home: options.home, claudeDir: claudeDir, talosHome: options.talosHome,
        threadId: id)
      if plan == nil { return fail(id, "start_failed", "the MCP list needs a talos-app server in the agent folder's .mcp.json") }
    }
    let sessionId = (resume ? r.entry.session_id : nil) ?? UUID().uuidString.lowercased()
    let nonce = Self.nonce()
    let d = dir(id)
    let launch = d + "/launch.sh"
    try? FileManager.default.createDirectory(
      atPath: WorkerSpec.noChannelDir(talosHome: options.talosHome), withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    unlink(d + "/ready")
    do {
      let spec = try WorkerSpec.build(
        .init(
          threadId: id, claudePath: options.claudePath, baseEnv: baseEnv(), talosHome: options.talosHome,
          agentDir: options.agentDir, cwd: cwd, model: s.model, effort: s.effort, permissionFlag: options.permissionFlag,
          sessionId: sessionId, resume: resume, nonce: nonce, preamble: preamble(id),
          mcpConfigPath: plan == nil ? mcpConfig(id, cwd: cwd) : nil, mcp: plan,
          mainMcpServers: WorkerMcp.visibleNames(cwd: options.agentDir, home: options.home, claudeDir: claudeDir),
          mainDenyRules: PrivilegeCeiling.mainDenyRules(agentDir: options.agentDir, talosHome: options.talosHome),
          mainArgs: options.mainArgs.isEmpty ? nil : options.mainArgs,
          mainDefaultMode: PrivilegeCeiling.mainDefaultMode(
            agentDir: options.agentDir, talosHome: options.talosHome, claudeDir: claudeDir, guardsActive: !guardsOff)))
      if let plan { try WorkerMcp.write(plan) }
      try AtomicFile.write(Data(spec.settingsJSON.utf8), to: WorkerSpec.settingsPath(talosHome: options.talosHome, threadId: id))
      try AtomicFile.write(Data(nonce.utf8), to: d + "/nonce", mode: 0o600)
      try AtomicFile.write(Data(spec.launchScript().utf8), to: launch, mode: 0o600)
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
    let create = tmux(id).withPane(nil).newSession(argv: ["/bin/sh", launch], env: [:], cwd: cwd)
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
    r.parkDeadline = nil
    r.parkReason = nil
    r.stopDeadline = nil
    r.afterPark = nil
    r.heldSince = nil
    r.enterOwed = false
    r.seenActivity = nil
    r.activityChangedAwake = nil
    r.forgetScreen()
    r.entry.state = "starting"
    r.entry.session_id = sessionId
    r.entry.pane_pid = 0
    r.entry.cwd = cwd
    r.entry.model = s.model
    // `mcp_allow` here is the list as configured, names that were not found included: it is compared with the config, not with the file
    r.entry.launched = .init(cwd: cwd, model: s.model, effort: s.effort, mcp_allow: s.mcpAllow)
    r.entry.started_at = ISOTime.string(t)
    r.entry.parked_at = nil
    r.entry.error = nil
    rt[id] = r
    dirty = true
    emit(.started(thread: id, resume: resume))
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
  private func isBusy(_ id: String, now t: Double) -> Bool {
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

  private func advance(_ id: String, settings: DedicatedSettings, now t: Double) {
    guard var r = rt[id], !r.adoptPending else { return }
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
      }
      let still = awake() - (rt[id]?.screenSameSince ?? awake()) >= options.dialogSettle
      let seen: DialogMatcher.Screen = still ? DialogMatcher.liveDialog(rows) : .none
      noteScreens(id, rows: rows, seen: seen, settled: still)
      answerDialog(id)  // a tap's answer for the dialog just noted (WorkerDialogAnswer.swift)
      r = rt[id] ?? r
      if r.entry.state == "starting" {
        if let waiting = seen.isDialog ? seen.label : r.promptWatch.current.map({ $0.title ?? "prompt" }) {
          // Workers have no dialog by design; one here (trust, MCP consent, login) needs the owner. The pane stays up so the
          // owner can answer it in the Terminals window (or with a tap); nothing else is typed. The ready timeout waits while it is on screen. A
          // dialog nobody answers for `dialogLimit` stops the worker as `needs_mac`, as before.
          if let since = r.dialogSinceAwake, awake() - since > options.dialogLimit {
            stopNow(id)
            return fail(id, "needs_mac", waiting)
          }
          rt[id]?.startedAwake = awake()
          return
        }
        if FileManager.default.fileExists(atPath: dir(id) + "/ready") {
          unlink(dir(id) + "/launch.sh")
          r.entry.state = "live"
          r.readyAt = t
          r.lastActive = t
          rt[id] = r
          dirty = true
          emit(.live(thread: id))
        } else if awake() - r.startedAwake > options.readyTimeout {
          stopNow(id)
          return fail(id, "start_failed", "the session never connected to Talos")
        } else {
          return
        }
      }
      noteScreen(&r, rows: rows, now: t)
      rt[id] = r
      let busy = readsBusy(id, ps, now: t)
      if r.entry.state == "stopping" {
        // here, after the pane and the screen were read: a failed read never gets this far
        if !busy {
          beginPark(id, reason: r.parkReason ?? "control")
        } else if let limit = r.stopDeadline, awake() >= limit {
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
      // a worker waiting on the owner is not parked for being quiet: the answer is what it is waiting for
      if !busy, !r.pendingPointer, r.needsYouPrompt == nil, t - r.lastActive >= idle, idleLimitPassed(id, idle: idle, now: t) {
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

  /// tmux or the kernel said so: never reached on a failed read.
  private func exited(_ id: String, rows: [String], settings: DedicatedSettings, now t: Double) {
    guard var r = rt[id] else { return }
    let wasStarting = r.entry.state == "starting"
    let wasStopping = r.entry.state == "stopping"
    // what the owner asked for on its way out still happens, and doesn't stay armed for some later park
    let after = r.afterPark
    r.afterPark = nil
    rt[id] = r
    if r.pgid > 0, signaller.alive(r.pgid) { signaller.signal(r.pgid, SIGKILL) }  // the children of a crashed worker
    release(id)
    r = rt[id] ?? r
    if wasStarting, DialogMatcher.resumeMissing(rows) {
      // the id is kept; [Start fresh] moves it to previous_ids (OPTION-C 2.5). Never a new id on our own.
      fail(id, "resume_missing", "No session found with ID")
      return runQueued(id, after: after, settings: settings, now: t)
    }
    r.restartTimes.append(t)
    r.entry.restarts = Array((r.entry.restarts + [ISOTime.string(t)]).suffix(10))
    rt[id] = r
    if WorkerPolicy.crashLooping(restarts: r.restartTimes, now: t) {
      fail(id, "crash_loop", "the session crashed 5 times in 15 minutes")
    } else if wasStarting {
      fail(id, "start_failed", "the session exited while starting")
    } else {
      // a crash: parked; the transcript is on disk and the next message resumes it
      rt[id]?.entry.state = "parked"
      rt[id]?.entry.parked_at = ISOTime.string(t)
      dirty = true
      emit(.parked(thread: id, reason: wasStopping ? rt[id]?.parkReason ?? "exited" : "exited"))
    }
    rt[id]?.parkReason = nil
    runQueued(id, after: after, settings: settings, now: t)
  }

  private func release(_ id: String) {
    guard let r = rt[id] else { return }
    _ = run(tmux(id).killSession())  // by exact name, on our private socket: never a pane id that may have moved
    if r.pgid > 0 { signaller.release(r.pgid) }
    rt[id]?.pgid = 0
    rt[id]?.paneId = nil
    rt[id]?.enterOwed = false
    rt[id]?.stopDeadline = nil
    rt[id]?.entry.pane_pid = 0
    rt[id]?.needsYouPrompt = nil
    rt[id]?.dialogSinceAwake = nil
    rt[id]?.dlg.reset()
    rt[id]?.promptWatch = PromptWatch()
    resetHolds(id)
    closeNoticeRecord(id)
    unlink(dir(id) + "/ready")
    unlink(dir(id) + "/nonce")
    unlink(dir(id) + "/launch.sh")
  }

  private func fail(_ id: String, _ code: String, _ detail: String, axis: String? = nil) {
    if rt[id] == nil { return }
    rt[id]?.entry.state = "failed"
    rt[id]?.entry.error = .init(code: code, detail: String(detail.prefix(300)), at: ISOTime.string(now()), axis: axis)
    rt[id]?.folderChangeTo = nil
    rt[id]?.pendingPointer = false
    rt[id]?.afterPark = nil
    rt[id]?.heldSince = nil
    dirty = true
    emit(.failed(thread: id, code: code))
  }

  // MARK: park and stop

  /// Park after the current turn (spec 2.4, 6.3, section 8 row 13): `stopping` until the pane goes quiet.
  func requestPark(_ id: String, reason: String, byOwner: Bool) {
    guard let r = rt[id], !r.adoptPending, WorkersFile.liveStates.contains(r.entry.state) else { return }
    rt[id]?.entry.state = "stopping"
    rt[id]?.parkReason = reason
    if byOwner { armStopLimit(id) }
    dirty = true
  }

  /// From the first tap: a second one doesn't buy the turn more time.
  func armStopLimit(_ id: String) {
    if rt[id]?.stopDeadline == nil { rt[id]?.stopDeadline = awake() + options.stopLimit }
  }

  /// SIGTERM now. Callers have checked the worker isn't mid-turn, or that the owner's stop limit has run out.
  private func beginPark(_ id: String, reason: String) {
    guard let r = rt[id], r.pgid > 0 else { return }
    signaller.signal(r.pgid, SIGTERM)
    rt[id]?.entry.state = "parking"
    rt[id]?.stopDeadline = nil
    rt[id]?.parkDeadline = awake() + options.parkGrace
    rt[id]?.parkReason = reason
    dirty = true
  }

  private func finishPark(_ id: String, settings: DedicatedSettings, now t: Double) {
    let reason = rt[id]?.parkReason ?? "idle"
    release(id)
    rt[id]?.entry.state = "parked"
    rt[id]?.entry.parked_at = ISOTime.string(t)
    rt[id]?.parkDeadline = nil
    rt[id]?.parkReason = nil
    dirty = true
    emit(.parked(thread: id, reason: reason))
    let after = rt[id]?.afterPark
    rt[id]?.afterPark = nil
    runQueued(id, after: after, settings: settings, now: t)
  }

  /// What arrived while a worker was on its way out, once it has gone, however it went.
  private func runQueued(_ id: String, after: String?, settings: DedicatedSettings, now t: Double) {
    guard let s = settings.threads[id] else {
      rt[id]?.pendingPointer = false
      return
    }
    if let after {
      perform(after, reason: "control", id, s, settings, t)
    } else if rt[id]?.pendingPointer == true {
      perform("pointer", reason: "message", id, s, settings, t)
    }
  }

  /// Stops at once (a dialog, the cap on an idle worker, Quit): SIGTERM, a short wait, then SIGKILL, on our own group.
  private func stopNow(_ id: String) {
    guard let r = rt[id] else { return }
    if r.pgid > 0 {
      signaller.signal(r.pgid, SIGTERM)
      let until = Date().addingTimeInterval(2)
      while signaller.alive(r.pgid), Date() < until { usleep(50_000) }
      if signaller.alive(r.pgid) { signaller.signal(r.pgid, SIGKILL) }
    }
    release(id)
    if rt[id]?.entry.state != "failed" {
      rt[id]?.entry.state = "parked"
      rt[id]?.entry.parked_at = ISOTime.string(now())
    }
    dirty = true
  }
}
