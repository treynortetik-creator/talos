import AppKit
import Combine
import Foundation
import TalosDesktopCore
import TalosSupervisor

extension ObservableObject {
  /// `@Published` announces every assignment, equal or not. A value that is the same again is not a change.
  @MainActor func setIfChanged<T: Equatable>(_ keyPath: ReferenceWritableKeyPath<Self, T>, to value: T) {
    if self[keyPath: keyPath] != value { self[keyPath: keyPath] = value }
  }
}

/// Gathers the four inputs of `HealthModel` (session, `status.json`, relay `/healthz`, the page's badge) and turns
/// supervisor events into notifications. Read-only: it never signals a process. The bridge's `status.json` writer lands
/// after WP-V6; until then the bridge line says "unknown".
@MainActor
final class StatusCoordinator: ObservableObject {
  static let shared = StatusCoordinator()

  @Published private(set) var summary = HealthModel.summarize(.init(session: .notConfigured))
  private weak var model: SupervisorController?
  private var timers: [Timer] = []
  private var bag = Set<AnyCancellable>()
  private var bridge: BridgeStatus.Health?
  private var relayOK: Bool?
  private var quiet: QuietWindow?
  private var lastPhase: Supervisor.Phase?
  private(set) var agentName = "Talos"
  private var started = false
  /// The companion's feed (spec 2.2): a Core-typed copy of the session, the page badge and the relay, recomputed with the
  /// menu's own inputs. Nothing adds a second poller.
  private(set) var companionInputs = CompanionInputs()
  /// nil until the first `readBridge` has returned: the companion decides nothing about quiet before that.
  private var bridgeRead = false
  private var relayFailures = 0
  /// Banners dropped inside the quiet window since launch (Morning reports them).
  private(set) var collected = 0
  var onCompanionChange: (() -> Void)?
  /// Tests set the clock.
  var now: () -> Date = { Date() }

  /// The quiet decision for the companion: nil until the bridge has been read, then whether this moment is inside the window.
  var quietNow: Bool? { bridgeRead ? (quiet?.isQuiet(now()) ?? false) : nil }
  var quietWindow: QuietWindow? { quiet }
  /// The companion's inputs with the two clock-dependent values taken now, not at the last recompute: a wake after a long sleep
  /// must not decide Morning on a quiet value from before the lid closed.
  var companionInputsNow: CompanionInputs {
    var i = companionInputs
    i.quiet = quietNow
    i.quietWindow = quiet
    i.collected = collected
    return i
  }
  /// Tests: stands in for what `readBridge` learns from config.json.
  func setQuietForTest(_ q: QuietWindow?) {
    quiet = q
    bridgeRead = true
  }

  private static var menuBarImages: [String: NSImage] = [:]

  /// Talos's head for the current state, 18 pt with a 1x and a 2x picture. A template image, so macOS tints it for light, dark and
  /// highlighted bars. nil when the app bundle lacks `Resources/menubar` or one of the state's pictures is missing or unreadable (a
  /// broken build; `build-app.sh` refuses to make one), and the menu bar then shows the word "Talos".
  var menuBarImage: NSImage? {
    let name = summary.icon.menuBarAsset
    if let hit = Self.menuBarImages[name] { return hit }
    guard let dir = Bundle.main.resourceURL?.appendingPathComponent("menubar", isDirectory: true) else { return nil }
    let pt = CGFloat(HealthSummary.Icon.menuBarPoints)
    let image = NSImage(size: NSSize(width: pt, height: pt))
    for scale in [1, 2] {
      guard let data = try? Data(contentsOf: dir.appendingPathComponent("\(name)-\(scale)x.png")),
        let rep = NSBitmapImageRep(data: data)
      else { return nil }
      rep.size = image.size
      image.addRepresentation(rep)
    }
    image.isTemplate = true
    image.accessibilityDescription = summary.icon.menuBarLabel  // a backup for the label the menu bar scene sets
    Self.menuBarImages[name] = image
    return image
  }

  func start(model: SupervisorController) {
    guard !started else { return }
    started = true
    self.model = model
    Notifier.shared.start()
    WebController.shared.onNotify = { title, body, navigate, tag in
      // While the pet can show the reply himself (on, awake, mic off, fed, not busy with something that outranks it), his
      // bubble replaces the page's reply banner (spec 4.3). Any other banner, and every other condition, is untouched.
      if CompanionController.shared.dropsReplyBanner(body: body) { return }
      if let n = NotificationPolicy.web(title: title, body: body, navigate: navigate, tag: tag, windowIsKey: false) {
        Notifier.shared.show(n)
      }
    }
    // No removeDuplicates: `notice` is never cleared, so the same text again is a new event; the 60 s tag limit handles bursts.
    model.$notice.sink { [weak self] text in self?.noticeChanged(text) }.store(in: &bag)
    // The feed is not @Published (it would rebuild the menu bar scene on every frame): its change callback recomputes the pet's
    // inputs here, so a store change reaches him within the frame's own 250 ms coalescing.
    WebController.shared.onCompanionFeed = { [weak self] _ in self?.recompute() }
    WebController.shared.objectWillChange.sink { [weak self] _ in DispatchQueue.main.async { self?.recompute() } }.store(in: &bag)
    schedule(2) { $0.recompute() }
    schedule(5) { $0.readBridge() }
    schedule(60) { $0.pollRelay() }
    readBridge()
    pollRelay()
    recompute()
  }

  private func schedule(_ every: TimeInterval, _ f: @escaping @MainActor (StatusCoordinator) -> Void) {
    timers.append(Timer.scheduledTimer(withTimeInterval: every, repeats: true) { [weak self] _ in
      Task { @MainActor in if let self { f(self) } }
    })
  }

  // MARK: inputs

  private var appHome: String {
    let cfgEnv = model?.supervisor.currentConfig().env["TALOS_APP_HOME"]
    return cfgEnv.flatMap { $0.isEmpty ? nil : $0 }
      ?? ProcessInfo.processInfo.environment["TALOS_APP_HOME"].flatMap { $0.isEmpty ? nil : $0 }
      ?? NSHomeDirectory() + "/.config/talos/app"
  }

  private func readBridge() {
    let home = appHome
    Task.detached {
      let data = FileManager.default.contents(atPath: home + "/status.json")
      let cfgData = FileManager.default.contents(atPath: home + "/config.json")
      let name = CrashPost.readAppConfig(cfgData).agentName
      let qw = QuietWindow.read(cfgData)
      let h = data.flatMap(BridgeStatus.decode)?.health(now: Date(), pidAlive: { kill($0, 0) == 0 || errno == EPERM })
      await MainActor.run {
        self.bridge = h
        if let name { self.agentName = name }
        self.quiet = qw
        self.bridgeRead = true
        self.recompute()
      }
    }
  }

  private func pollRelay() {
    guard let relay = WebController.shared.relay else { relayOK = nil; relayFailures = 0; return }
    var req = URLRequest(url: relay.url.appending(path: "healthz"))
    req.timeoutInterval = 8
    URLSession.shared.dataTask(with: req) { data, resp, _ in
      let ok = (resp as? HTTPURLResponse).map { RelayHealth.ok(status: $0.statusCode, body: data ?? Data()) } ?? false
      Task { @MainActor in
        self.relayOK = ok
        self.relayFailures = ok ? 0 : self.relayFailures + 1
        self.recompute()
      }
    }.resume()
  }

  private func recompute() {
    guard let model else { return }
    let st = model.status
    let session: HealthModel.Session
    if !model.configured {
      session = .notConfigured
    } else {
      switch st.phase {
      case .idle: session = .notStarted
      case .blocked: session = .blocked
      case .starting: session = .starting
      case .running: session = .running(activity: st.agentActivity)
      case .cleaningUp, .waitingToRestart: session = .restarting
      case .stopping: session = .stopping
      case .stopped(let r): session = .stopped(Self.describe(r))
      }
    }
    // A supervisor restart that came back without a dev-channel dialog never raises `autoConfirmed`: notice it here.
    if let prev = lastPhase, prev == .cleaningUp || prev == .waitingToRestart, st.phase == .starting || st.phase == .running,
      st.startKind == .supervisorRestart
    {
      notify(.restartedAfterCrash)
    }
    lastPhase = st.phase
    let next = HealthModel.summarize(
      .init(
        session: session, sessionNeedsYou: st.needsYou != nil, badge: WebController.shared.needsYou, bridge: bridge,
        relayReachable: relayOK, relayConfigured: WebController.shared.hasRelay, host: st.host == .tmux ? "tmux" : "owned pty"))
    setIfChanged(\.summary, to: next)  // @Published fires on every set: the menu bar scene rebuilds only on a real change
    companionInputs = Self.companionInputs(
      phase: st.phase, configured: model.configured, activity: st.agentActivity, sessionNeedsYou: st.needsYou != nil,
      badge: WebController.shared.needsYou, relayFailures: relayFailures, relayConfigured: WebController.shared.hasRelay,
      agentName: agentName, quiet: quietNow, quietWindow: quiet, collected: collected,
      feed: WebController.shared.companionFeed, pageStatus: WebController.shared.companionPageStatus,
      threads: WebController.shared.threads.map { CompanionThreadRef(id: $0.id, name: $0.name) },
      windowIsKey: WebController.shared.windowIsKey)
    onCompanionChange?()
  }

  /// The companion's picture of the session. The owner's own stop is a flag, never compared by text. A relay that failed twice
  /// running is Down; one failure is not.
  static func companionInputs(
    phase: Supervisor.Phase, configured: Bool, activity: String?, sessionNeedsYou: Bool, badge: Int, relayFailures: Int,
    relayConfigured: Bool, agentName: String, quiet: Bool?, quietWindow: QuietWindow?, collected: Int,
    feed: CompanionFeed? = nil, pageStatus: CompanionPageStatus = .down, threads: [CompanionThreadRef] = [],
    windowIsKey: Bool = false
  ) -> CompanionInputs {
    var i = CompanionInputs()
    if !configured {
      i.session = .notConfigured
    } else {
      switch phase {
      case .idle: i.session = .notStarted
      case .blocked: i.session = .blocked
      case .starting: i.session = .starting
      case .running: i.session = .running(busy: activity == "busy")
      case .cleaningUp, .waitingToRestart: i.session = .restarting
      case .stopping: i.session = .stopping
      case .stopped(let r):
        if case .user = r { i.session = .stopped(byOwner: true) } else { i.session = .stopped(byOwner: false) }
      }
    }
    i.sessionNeedsYou = sessionNeedsYou
    i.needs = badge
    i.relayDown = relayConfigured && relayFailures >= 2
    i.agentName = agentName
    i.quiet = quiet
    i.quietWindow = quietWindow
    i.collected = collected
    i.feed = feed
    i.pageStatus = pageStatus
    i.threads = threads
    i.windowIsKey = windowIsKey
    return i
  }

  // MARK: supervisor events -> notifications

  private func noticeChanged(_ text: String) {
    if let event = SupervisorNotice.event(for: text) { notify(event) }
  }

  /// Supervisor banners stay quiet inside the owner's quiet window (like the relay's Mac-side alarms); the menu still shows it.
  func notify(_ event: NotificationPolicy.Supervisor) {
    if quiet?.isQuiet(now()) == true {
      collected += 1  // collected for Morning, shown by the companion's still dot
      return
    }
    Notifier.shared.show(NotificationPolicy.notice(event, agent: agentName))
  }

  static func describe(_ r: Supervisor.StopReason) -> String {
    switch r {
    case .user: return "stopped"
    case .crashLoop: return "stopped restarting after repeated crashes"
    case .resumeMissing: return "the conversation can't be resumed"
    case .noNotice: return "the restart wasn't confirmed"
    case .crashedNoAutoRestart: return "crashed (auto-restart is off)"
    case .startFailed: return "couldn't start"
    }
  }
}
