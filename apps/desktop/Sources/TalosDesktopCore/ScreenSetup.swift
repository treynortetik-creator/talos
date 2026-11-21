import Foundation

/// Lane 4: Setup's "Screen control" rows. The two macOS grants belong to Talos.app, so the rows ask about Talos.app and test the
/// screen helper itself (the same `ScreenCore` the screen socket uses): one filtered capture and one input probe that posts nothing
/// visible. A tick here means the agent's screen tools work, not just that some program has a grant.
///
/// Nothing here asks macOS for anything by itself: the two Grant buttons are the only calls that can show a macOS prompt, and they
/// go through `ScreenGrantActions`, which tests replace.

/// The two prompts, or a fake. Each returns what macOS says right after asking.
public protocol ScreenGrantActions: Sendable {
  /// `CGRequestScreenCaptureAccess`: macOS shows its prompt once; after that it only opens the setting.
  func requestScreenRecording() -> Bool
  /// `AXIsProcessTrustedWithOptions` with the prompt: macOS shows its prompt and adds Talos to the Accessibility list.
  func requestAccessibility() -> Bool
}

/// Whether Grant for Screen Recording was pressed in an earlier run of Talos. macOS counts that grant only after a relaunch, so
/// "pressed, and still no" means something only once Talos has started again.
public protocol ScreenGrantMemory: Sendable {
  /// Grant was pressed in this run.
  func recordPress()
  /// Grant was pressed in a run before this one.
  func pressedInEarlierRun() -> Bool
  /// macOS says yes now: forget the press.
  func clear()
}

/// The press, kept in a file that holds a token for the run that pressed. Another token there means another run pressed.
public final class FileScreenGrantMemory: ScreenGrantMemory, @unchecked Sendable {
  /// One per process: a relaunch is a new run.
  public static let thisRun = UUID().uuidString
  let path: String
  let run: String
  public init(path: String, run: String = FileScreenGrantMemory.thisRun) {
    self.path = path
    self.run = run
  }
  public func recordPress() {
    let dir = (path as NSString).deletingLastPathComponent
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    try? Data(run.utf8).write(to: URL(fileURLWithPath: path), options: .atomic)
  }
  public func pressedInEarlierRun() -> Bool {
    guard let d = FileManager.default.contents(atPath: path), let t = String(data: d, encoding: .utf8), !t.isEmpty else { return false }
    return t != run
  }
  public func clear() { try? FileManager.default.removeItem(atPath: path) }
}

/// What the live test found for one part.
public enum ScreenLiveResult: Equatable, Sendable {
  case working
  /// The plain reason, for the owner.
  case failed(String)
}

public struct ScreenLiveTest: Equatable, Sendable {
  public var see: ScreenLiveResult
  public var control: ScreenLiveResult
  public init(see: ScreenLiveResult, control: ScreenLiveResult) {
    self.see = see
    self.control = control
  }
}

extension ScreenCore {
  /// The live test of the screen helper itself, run by the owner from Setup: one capture through the agent's own filter with no
  /// app allowed (so it can only show the desktop picture) and one input probe. Never raises a permission prompt: a missing grant
  /// is a failed part in words.
  public func liveTest(signing: any ScreenCodeSigning = LiveCodeSigning()) async -> ScreenLiveTest {
    let see: ScreenLiveResult
    do {
      // no app on the list: only the desktop (checked as Apple's own code) can show
      let shot = try await agentCapture(allowed: ScreenAllowed(apps: [], signing: signing))
      see = shot.png.isEmpty ? .failed(ScreenSetupText.emptyShot) : .working
    } catch {
      see = .failed(ScreenSetupText.reason(error))
    }
    let control: ScreenLiveResult
    if !permissions.accessibility() {
      control = .failed(ScreenSetupText.missing(.accessibility))
    } else {
      do {
        try input.probe()
        control = .working
      } catch let r as ScreenRefusal {
        control = .failed(ScreenSetupText.reason(r))
      } catch {
        control = .failed(ScreenSetupText.probeFailed(ScreenRefusal.detail(error)))
      }
    }
    return ScreenLiveTest(see: see, control: control)
  }
}

/// The owner's words for the Screen control rows (design brief "What you would see").
public enum ScreenSetupText {
  public enum Part: Equatable, Sendable { case screenRecording, accessibility }

  public static let header = "Screen control: lets your agent see the screen and click and type for you. Talos asks macOS once."
  public static let working = "Working"
  public static let notTested = "Not tested yet."
  public static let testing = "Testing…"
  public static let reopen =
    "After you turn on Screen Recording, macOS needs Talos to Quit & Reopen. Your agent keeps running."
  public static let emptyShot = "The test screenshot came back empty."
  /// Grant was pressed in an earlier run of Talos and macOS still says no: most often the row in System Settings belongs to an
  /// older signature of Talos (another build or signer), which macOS keeps until it is removed.
  public static let staleEntry =
    "macOS may still hold an old Talos entry. In System Settings → Privacy & Security → Screen & System Audio Recording, select Talos, press −, then Allow here again."

  public static func missing(_ p: Part) -> String {
    switch p {
    case .accessibility: return "macOS hasn't allowed it yet: open Privacy & Security → Accessibility and turn on Talos."
    case .screenRecording:
      return "macOS hasn't allowed it yet: open Privacy & Security → Screen & System Audio Recording and turn on Talos."
    }
  }

  public static func notServing(_ why: String) -> String { "The screen helper isn't running, so your agent can't use the screen: \(why)" }
  public static func probeFailed(_ d: String) -> String { "Talos couldn't send a test event: \(d)." }

  /// A refusal in the owner's words: a missing grant names where to turn it on.
  public static func reason(_ e: any Error) -> String {
    switch e as? ScreenRefusal {
    case .screenRecordingNotGranted?: return missing(.screenRecording)
    case .accessibilityNotGranted?: return missing(.accessibility)
    case let r?: return r.reason
    case nil: return "The test failed: \(ScreenRefusal.detail(e))."
    }
  }
}

/// The Screen control part of Setup → Permissions, as data: each row's state and words, the Grant buttons and the live test.
/// Used on the main thread by the view.
public final class ScreenSetupModel: @unchecked Sendable {
  public struct Row: Equatable, Sendable, Identifiable {
    public var id: PermissionsModel.Kind { kind }
    public var kind: PermissionsModel.Kind
    public var part: ScreenSetupText.Part
    /// What macOS says, without asking.
    public var granted: Bool
    /// The live test's word for this part: "Working" or the reason; nil before a test.
    public var status: String?
    public var working: Bool
    /// The System Settings pane for this grant.
    public var settingsURL: String
  }

  let permissions: any ScreenPermissionProbe
  let grants: any ScreenGrantActions
  let test: @Sendable () async -> ScreenLiveTest
  /// Nil while the screen socket answers; the reason when it is not running.
  let serving: @Sendable () -> String?
  let memory: (any ScreenGrantMemory)?

  public private(set) var last: ScreenLiveTest?
  public private(set) var testing = false
  /// Set after the owner pressed Grant for Screen Recording and macOS still says no: the Quit & Reopen line shows.
  public private(set) var showReopen = false

  public init(
    permissions: any ScreenPermissionProbe, grants: any ScreenGrantActions, test: @escaping @Sendable () async -> ScreenLiveTest,
    serving: @escaping @Sendable () -> String? = { nil }, memory: (any ScreenGrantMemory)? = nil
  ) {
    self.permissions = permissions
    self.grants = grants
    self.test = test
    self.serving = serving
    self.memory = memory
  }

  /// Grant for Screen Recording was pressed in an earlier run, and macOS still says no after that relaunch: the line that says how
  /// to remove an old Talos entry shows. A yes from macOS forgets the press.
  public var showStaleEntry: Bool {
    guard let memory else { return false }
    if permissions.screenRecording() {
      memory.clear()
      return false
    }
    return memory.pressedInEarlierRun()
  }

  public var rows: [Row] {
    [row(.screenRecording, .screenRecording, permissions.screenRecording(), last?.see),
     row(.accessibility, .accessibility, permissions.accessibility(), last?.control)]
  }

  func row(_ kind: PermissionsModel.Kind, _ part: ScreenSetupText.Part, _ granted: Bool, _ result: ScreenLiveResult?) -> Row {
    let pane = part == .screenRecording ? "Privacy_ScreenCapture" : "Privacy_Accessibility"
    var status: String?
    var working = false
    if let notServing = serving() {
      status = ScreenSetupText.notServing(notServing)
    } else if !granted {
      status = ScreenSetupText.missing(part)
    } else {
      switch result {
      case .working?:
        status = ScreenSetupText.working
        working = true
      case .failed(let why)?: status = why
      case nil: status = testing ? ScreenSetupText.testing : ScreenSetupText.notTested
      }
    }
    return Row(kind: kind, part: part, granted: granted, status: status, working: working, settingsURL: PermissionsModel.settingsBase + pane)
  }

  /// The row's state in the Permissions list: granted only when the live test said Working.
  public func state(_ kind: PermissionsModel.Kind) -> PermissionsModel.State {
    guard let r = rows.first(where: { $0.kind == kind }) else { return .unknown }
    return r.working ? .granted : .missing
  }

  /// The Grant button. The only call here that can show a macOS prompt.
  public func grant(_ part: ScreenSetupText.Part) {
    switch part {
    case .screenRecording:
      memory?.recordPress()
      let now = grants.requestScreenRecording()
      // macOS counts a Screen Recording grant only after Talos restarts
      if !now { showReopen = true }
    case .accessibility:
      _ = grants.requestAccessibility()
    }
  }

  /// Runs the live test (Setup opens, Check again, after a grant).
  public func runTest() async {
    testing = true
    defer { testing = false }
    // the screen socket is down: its reason is the answer (rows say it), so nothing is captured
    if serving() != nil {
      last = nil
      return
    }
    last = await test()
  }
}
