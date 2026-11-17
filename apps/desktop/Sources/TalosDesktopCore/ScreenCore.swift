import CoreGraphics
import Foundation

/// What a Talos session sees of the screen and how it clicks and types (screen helper, lane 1). The rules live here, in one
/// place the socket server (lane 2) and the capture hotkey (lane 5) both go through; the four macOS pieces (ScreenCaptureKit,
/// CGEvent, NSWorkspace, the two permission checks) sit behind protocols so every rule is tested with fakes.
///
/// The rules:
/// - `agentCapture` shows only the windows of allowed apps, plus the desktop picture. Every other window is a gap. The filter
///   is an allow list (windows named one by one), so a window that opens after the list was read is a gap as well. When the
///   list cannot be read, the answer is a refusal with a plain reason, never the whole screen.
/// - `ownerCapture` is the owner's own keypress: whole display, one window or a region, unfiltered.
/// - Input goes only to an allowed app that is in front at the moment of each event, and never to Talos itself. A click or a
///   scroll also needs the window under the pointer to belong to an allowed app.
/// - Nothing here asks macOS for a permission. A missing one is a refusal, checked before any capture or event, so no system
///   prompt is ever raised by an agent's call.
public struct ScreenCore: Sendable {
  /// The Talos app's own bundle id (`Resources/Info.plist.template`).
  public static let talosBundleID = "app.talos.desktop"
  /// The long edge, in pixels, a PNG is scaled down to by default.
  public static let defaultMaxLongEdge = 1568

  let capture: any ScreenCaptureBackend
  let input: any ScreenInputBackend
  let apps: any ScreenAppsBackend
  let permissions: any ScreenPermissionProbe
  /// Bundle ids that count as Talos (compared without case) and this process's pid: input to them is always refused.
  let selfBundleIDs: Set<String>
  let selfPID: Int32
  public var maxLongEdge: Int
  /// Keys besides `ScreenKeyGuard`'s own that are never pressed: the owner's Talos hotkeys and this Mac's enabled shortcuts.
  public var refusedKeys: @Sendable () -> [ScreenKeyCombo] = { [] }
  /// How typing waits between pieces (`textPaceSeconds`); tests record it instead of sleeping.
  public var pause: @Sendable (Double) -> Void = { usleep(useconds_t(max(0, $0) * 1_000_000)) }

  public init(
    capture: any ScreenCaptureBackend, input: any ScreenInputBackend, apps: any ScreenAppsBackend,
    permissions: any ScreenPermissionProbe, selfBundleID: String?, selfPID: Int32, maxLongEdge: Int = defaultMaxLongEdge
  ) {
    self.capture = capture
    self.input = input
    self.apps = apps
    self.permissions = permissions
    var ids: Set<String> = [Self.talosBundleID.lowercased()]
    if let s = selfBundleID?.trimmingCharacters(in: .whitespaces), !s.isEmpty { ids.insert(s.lowercased()) }
    self.selfBundleIDs = ids
    self.selfPID = selfPID
    self.maxLongEdge = maxLongEdge
  }

  // MARK: capture

  /// A screenshot for an agent: only the allowed apps' windows and the desktop picture.
  public func agentCapture(allowed: ScreenAllowed, area: ScreenArea = .full) async throws(ScreenRefusal) -> ScreenShot {
    guard permissions.screenRecording() else { throw .screenRecordingNotGranted }
    let content: ScreenContent
    do { content = try await capture.content() } catch {
      throw .filterUnavailable(ScreenRefusal.detail(error))
    }
    let plan = try ScreenPlanner.agent(area: area, allowed: allowed, content: content)
    return try await shoot(plan)
  }

  /// The owner's own screenshot (the hotkey): unfiltered.
  public func ownerCapture(mode: ScreenArea) async throws(ScreenRefusal) -> ScreenShot {
    guard permissions.screenRecording() else { throw .screenRecordingNotGranted }
    let content: ScreenContent
    do { content = try await capture.content() } catch {
      throw .captureFailed(ScreenRefusal.detail(error))
    }
    return try await shoot(ScreenPlanner.owner(area: mode, content: content))
  }

  func shoot(_ planned: ScreenPlanner.Planned) async throws(ScreenRefusal) -> ScreenShot {
    let image: CGImage
    do { image = try await capture.image(planned.plan) } catch let r as ScreenRefusal { throw r } catch {
      throw .captureFailed(ScreenRefusal.detail(error))
    }
    let png = try ScreenPNG.encode(image, maxLongEdge: maxLongEdge)
    return ScreenShot(
      png: png.data, width: png.width, height: png.height, area: planned.area, shownApps: planned.shownApps,
      hiddenWindows: planned.hiddenWindows)
  }

  // MARK: apps

  /// The running apps a person can see (regular apps), by name.
  public func runningApps() -> [ScreenApp] {
    apps.runningApps().sorted { ($0.name.lowercased(), $0.pid) < ($1.name.lowercased(), $1.pid) }
  }

  /// Opens (or brings forward) an allowed app. Talos itself and apps not on the list are refused. The app on disk that macOS would
  /// open for the id is the one checked against the owner's entry, and that same app is opened: an impostor that claims the id
  /// is not opened.
  public func openApp(bundleID: String, allowed: ScreenAllowed) async throws(ScreenRefusal) {
    let id = bundleID.trimmingCharacters(in: .whitespaces)
    guard !id.isEmpty else { throw .badRequest("no app named") }
    guard !Self.isTalos(id, selfBundleIDs) else { throw .talosItself }
    guard let path = apps.appPath(bundleID: id) else {
      throw allowed.entry(id) == nil ? .appNotAllowed(app: id) : .openFailed(app: id, detail: "no app with that id is installed")
    }
    guard allowed.allowsInstalled(bundleID: id, appPath: path) else { throw .appNotAllowed(app: id, subject: .installed(path: path)) }
    do { try await apps.open(appPath: path) } catch let r as ScreenRefusal { throw r } catch {
      throw .openFailed(app: id, detail: ScreenRefusal.detail(error))
    }
  }

  /// Talos's own ids: this app's, the release id, and anything under `app.talos.` (helpers, dev builds). Never on the list.
  public static func isTalos(_ bundleID: String, _ selfIDs: Set<String> = [talosBundleID]) -> Bool {
    let b = bundleID.trimmingCharacters(in: .whitespaces).lowercased()
    return selfIDs.contains(b) || b == talosBundleID || b.hasPrefix("app.talos.")
  }

  func isSelf(_ app: ScreenApp) -> Bool {
    app.pid == selfPID || app.bundleID.map { Self.isTalos($0, selfBundleIDs) } == true
  }
}

/// Which part of the screen. Points, global, top-left origin (the coordinates ScreenCaptureKit and CGEvent use).
public enum ScreenArea: Sendable, Equatable {
  /// The main display.
  case full
  case display(UInt32)
  case window(UInt32)
  case region(CGRect)
}

/// A captured screen as a PNG, and what it shows.
public struct ScreenShot: Sendable, Equatable {
  public var png: Data
  /// Pixels of the PNG (after the downscale).
  public var width: Int
  public var height: Int
  /// The part of the screen it shows, in global points.
  public var area: CGRect
  /// Bundle ids whose windows it shows (the desktop picture not counted). Nil for an owner capture: everything shows.
  public var shownApps: [String]?
  /// On-screen windows in the area left out because their app is not allowed (0 for an owner capture).
  public var hiddenWindows: Int
}

public struct ScreenApp: Sendable, Equatable {
  public var bundleID: String?
  public var pid: Int32
  public var name: String
  public init(bundleID: String?, pid: Int32, name: String) {
    self.bundleID = bundleID
    self.pid = pid
    self.name = name
  }
}

public struct ScreenWindow: Sendable, Equatable {
  public var id: UInt32
  public var ownerBundleID: String?
  public var ownerPID: Int32
  /// Global points, top-left origin.
  public var frame: CGRect
  /// The window level; the desktop picture and desktop icons sit below zero.
  public var layer: Int
  public var isOnScreen: Bool
  public init(id: UInt32, ownerBundleID: String?, ownerPID: Int32, frame: CGRect, layer: Int = 0, isOnScreen: Bool = true) {
    self.id = id
    self.ownerBundleID = ownerBundleID
    self.ownerPID = ownerPID
    self.frame = frame
    self.layer = layer
    self.isOnScreen = isOnScreen
  }

  /// The processes that draw the desktop picture and the desktop icons (macOS 15-26: WallpaperAgent, the Dock, Finder). Not
  /// Notification Center (its widgets sit at desktop level) and nothing else, whatever id it claims.
  public static let desktopOwners: Set<String> = ["com.apple.wallpaper.agent", "com.apple.dock", "com.apple.finder"]

  /// A candidate for the desktop: below normal windows and owned by one of `desktopOwners`. A bundle id is only a claim: the
  /// agent capture also asks macOS that the owning process is Apple's own code (`ScreenCodeSigning.isApple`) before it
  /// draws one.
  public var isDesktop: Bool { layer < 0 && ownerBundleID.map(Self.desktopOwners.contains) == true }
}

public struct ScreenDisplay: Sendable, Equatable {
  public var id: UInt32
  /// Global points, top-left origin.
  public var frame: CGRect
  public init(id: UInt32, frame: CGRect) {
    self.id = id
    self.frame = frame
  }
}

/// What is on screen, as macOS lists it.
public struct ScreenContent: Sendable, Equatable {
  public var displays: [ScreenDisplay]
  public var windows: [ScreenWindow]
  public var mainDisplayID: UInt32?
  public init(displays: [ScreenDisplay], windows: [ScreenWindow], mainDisplayID: UInt32?) {
    self.displays = displays
    self.windows = windows
    self.mainDisplayID = mainDisplayID
  }
}

/// A window a capture may show, named by id and by who owns it: a backend draws it only when all three still match.
public struct PlannedWindow: Sendable, Equatable, Hashable {
  public var id: UInt32
  public var ownerBundleID: String?
  public var ownerPID: Int32
  public init(_ w: ScreenWindow) {
    id = w.id
    ownerBundleID = w.ownerBundleID
    ownerPID = w.ownerPID
  }
  public func matches(_ w: ScreenWindow) -> Bool { w.id == id && w.ownerBundleID == ownerBundleID && w.ownerPID == ownerPID }
}

/// What a backend is asked to draw.
public struct CapturePlan: Sendable, Equatable {
  public enum Source: Sendable, Equatable {
    /// A display. `only` nil: everything on it (owner only). `only` set: just those windows, the rest a gap.
    case display(UInt32, only: [PlannedWindow]?)
    case window(PlannedWindow)
  }
  public var source: Source
  /// Part of the source to keep, in the source's own points (top-left origin). Nil: all of it.
  public var crop: CGRect?
}

/// Turns an area and the allow list into a `CapturePlan`. Pure.
enum ScreenPlanner {
  struct Planned: Equatable {
    var plan: CapturePlan
    var area: CGRect
    var shownApps: [String]?
    var hiddenWindows: Int
  }

  static func agent(area: ScreenArea, allowed: ScreenAllowed, content: ScreenContent) throws(ScreenRefusal) -> Planned {
    if case .window(let id) = area {
      guard let w = content.windows.first(where: { $0.id == id && $0.isOnScreen }) else { throw .windowNotFound(id) }
      guard allowed.allows(bundleID: w.ownerBundleID, pid: w.ownerPID) else {
        throw .appNotAllowed(app: w.ownerBundleID ?? "an app with no id", subject: .running(pid: w.ownerPID))
      }
      return Planned(
        plan: CapturePlan(source: .window(PlannedWindow(w)), crop: nil), area: w.frame, shownApps: [w.ownerBundleID ?? ""],
        hiddenWindows: 0)
    }
    let (display, crop) = try where_(area, content)
    let global = crop.map { $0.offsetBy(dx: display.frame.minX, dy: display.frame.minY) } ?? display.frame
    var shown: [PlannedWindow] = []
    var apps = Set<String>()
    var hidden = 0
    for w in content.windows where w.isOnScreen && w.frame.intersects(global) {
      if w.isDesktop, let b = w.ownerBundleID, allowed.isAppleProcess(w.ownerPID, claiming: b) {
        shown.append(PlannedWindow(w))
      } else if allowed.allows(bundleID: w.ownerBundleID, pid: w.ownerPID), let b = w.ownerBundleID {
        shown.append(PlannedWindow(w))
        apps.insert(b)
      } else {
        hidden += 1
      }
    }
    return Planned(
      plan: CapturePlan(source: .display(display.id, only: shown), crop: crop), area: global, shownApps: apps.sorted(),
      hiddenWindows: hidden)
  }

  static func owner(area: ScreenArea, content: ScreenContent) throws(ScreenRefusal) -> Planned {
    if case .window(let id) = area {
      guard let w = content.windows.first(where: { $0.id == id && $0.isOnScreen }) else { throw .windowNotFound(id) }
      return Planned(plan: CapturePlan(source: .window(PlannedWindow(w)), crop: nil), area: w.frame, shownApps: nil, hiddenWindows: 0)
    }
    let (display, crop) = try where_(area, content)
    let global = crop.map { $0.offsetBy(dx: display.frame.minX, dy: display.frame.minY) } ?? display.frame
    return Planned(plan: CapturePlan(source: .display(display.id, only: nil), crop: crop), area: global, shownApps: nil, hiddenWindows: 0)
  }

  /// The display an area is on, and the crop within it (nil for a whole display).
  static func where_(_ area: ScreenArea, _ content: ScreenContent) throws(ScreenRefusal) -> (ScreenDisplay, CGRect?) {
    switch area {
    case .full:
      let main = content.displays.first { $0.id == content.mainDisplayID } ?? content.displays.first
      guard let main else { throw .noDisplay }
      return (main, nil)
    case .display(let id):
      guard let d = content.displays.first(where: { $0.id == id }) else { throw .displayNotFound(id) }
      return (d, nil)
    case .region(let r):
      let r = r.standardized
      guard r.minX.isFinite, r.minY.isFinite, r.width.isFinite, r.height.isFinite, r.width >= 1, r.height >= 1 else {
        throw .badRequest("the region needs a width and a height of at least one point")
      }
      // The display holding most of it; the part on other displays is left out.
      var best: (ScreenDisplay, CGRect)?
      var bestArea: CGFloat = 0
      for d in content.displays {
        let part = d.frame.intersection(r)
        guard !part.isNull, part.width >= 1, part.height >= 1 else { continue }
        let a: CGFloat = part.width * part.height
        if a > bestArea {
          best = (d, part)
          bestArea = a
        }
      }
      guard let (d, part) = best else { throw .regionOffScreen }
      return (d, part.offsetBy(dx: -d.frame.minX, dy: -d.frame.minY))
    case .window:
      throw .badRequest("a window is not a display")
    }
  }
}

/// Why the screen helper did not do something, as one plain line for the owner or the agent.
public enum ScreenRefusal: Error, Equatable, Sendable {
  case screenRecordingNotGranted
  case accessibilityNotGranted
  /// The window list could not be read, so the capture could not be limited to the allowed apps.
  case filterUnavailable(String)
  case captureFailed(String)
  case encodeFailed(String)
  case noDisplay
  case displayNotFound(UInt32)
  case windowNotFound(UInt32)
  case regionOffScreen
  /// `subject`: the app it is about, when the Mac can measure it for the owner's card. Nil: nothing to ask about.
  case appNotAllowed(app: String, subject: ScreenSubject? = nil)
  /// The app can never go on the list (unsigned, no app id); `why` is one plain line.
  case appNotAllowable(app: String, why: String)
  case talosItself
  /// A shortcut macOS or Talos handles for the whole Mac (`ScreenKeyGuard`); the text as the agent wrote it.
  case keyNotAllowed(String)
  /// A cmd/ctrl/opt combination that is not one of the front app's own menu shortcuts (review R2-2).
  case keyNotInMenu(keys: String, app: String)
  /// The keyboard is somewhere else than the front app (a non-activating panel, say): nothing more is sent.
  case focusElsewhere(app: String)
  /// An invisible window of `app` lies over the point and `app` is not on the allowed list: the click would go to it.
  case coveredByInvisibleWindow(app: String)
  /// Another app came to the front after a key went to `app`; the rest was not sent.
  case frontChanged(app: String)
  /// The point is the menu bar, a menu bar extra or another window above normal ones (level 24 and up).
  case systemArea
  case noFrontmostApp
  case nothingAtPoint
  case openFailed(app: String, detail: String)
  case inputFailed(String)
  case badRequest(String)

  public var reason: String {
    switch self {
    case .screenRecordingNotGranted:
      return "macOS hasn't allowed Talos to see the screen yet. On the Mac: Talos → Permissions → Grant. Nothing is stuck."
    case .accessibilityNotGranted:
      return "macOS hasn't allowed Talos to control the screen yet. On the Mac: Talos → Permissions → Grant. Nothing is stuck."
    case .filterUnavailable(let d):
      return "Talos could not limit the screenshot to the apps you allowed (\(d)), so it took no screenshot."
    case .captureFailed(let d): return "The screenshot failed: \(d)."
    case .encodeFailed(let d): return "The screenshot could not be saved as an image: \(d)."
    case .noDisplay: return "No display is connected."
    case .displayNotFound(let id): return "There is no display \(id)."
    case .windowNotFound(let id): return "Window \(id) is not on screen."
    case .regionOffScreen: return "That region is not on any display."
    case .appNotAllowed(let app, _): return "\(app) isn't on this Mac's allowed list yet."
    case .appNotAllowable(_, let why): return why
    case .talosItself: return "Talos does not let an agent click or type in Talos itself."
    case .keyNotAllowed(let k):
      return "\(String(k.prefix(60))) is a shortcut macOS or Talos handles for the whole Mac, so Talos never presses it for an agent. Nothing was pressed."
    case .keyNotInMenu(let k, let app):
      return "\(String(k.prefix(60))) isn't one of \(String(app.prefix(80)))'s own menu shortcuts, so Talos didn't press it. Plain keys and shift work anywhere; for anything else use the app's menus."
    case .focusElsewhere(let app):
      return "Another app has the keyboard, not \(String(app.prefix(80))), so Talos stopped there. Take a screenshot to see where things are."
    case .coveredByInvisibleWindow(let app):
      return "An invisible window of \(String(app.prefix(80))) covers that point, and \(String(app.prefix(80))) isn't allowed. Nothing was clicked: take a screenshot, or click another point."
    case .frontChanged(let app):
      return "Another app came to the front after \(String(app.prefix(80))) got the last key, so Talos stopped there. Take a screenshot to see where things are."
    case .systemArea: return "That spot is the menu bar or a system overlay, which Talos never clicks for an agent. Nothing was clicked."
    case .noFrontmostApp: return "No app is in front, so nothing was clicked or typed."
    case .nothingAtPoint: return "Nothing is at that spot on the screen, so nothing was clicked."
    case .openFailed(let app, let d): return "\(app) did not open: \(d)."
    case .inputFailed(let d): return "The click or keypress was not sent: \(d)."
    case .badRequest(let d): return "Bad request: \(d)."
    }
  }

  /// The stable name the screen socket sends (`screen.sock`): the bridge words its own text from it.
  public var code: String {
    switch self {
    case .screenRecordingNotGranted: return "screen_recording_not_granted"
    case .accessibilityNotGranted: return "accessibility_not_granted"
    case .filterUnavailable: return "filter_unavailable"
    case .captureFailed: return "capture_failed"
    case .encodeFailed: return "encode_failed"
    case .noDisplay: return "no_display"
    case .displayNotFound: return "display_not_found"
    case .windowNotFound: return "window_not_found"
    case .regionOffScreen: return "region_off_screen"
    case .appNotAllowed: return "app_not_allowed"
    case .appNotAllowable: return "app_not_allowable"
    case .talosItself: return "talos_itself"
    case .keyNotAllowed: return "key_not_allowed"
    case .keyNotInMenu: return "key_not_in_menu"
    case .focusElsewhere: return "focus_elsewhere"
    case .coveredByInvisibleWindow: return "covered_by_invisible_window"
    case .frontChanged: return "front_changed"
    case .systemArea: return "system_area"
    case .noFrontmostApp: return "no_frontmost_app"
    case .nothingAtPoint: return "nothing_at_point"
    case .openFailed: return "open_failed"
    case .inputFailed: return "input_failed"
    case .badRequest: return "bad_request"
    }
  }

  /// The app a refusal is about, when it names one.
  public var app: String? {
    switch self {
    case .appNotAllowed(let a, _), .appNotAllowable(let a, _), .openFailed(let a, _): return a
    default: return nil
    }
  }

  /// A short, single-line description of an underlying error.
  static func detail(_ error: any Error) -> String {
    let s = (error as NSError).localizedDescription.replacingOccurrences(of: "\n", with: " ")
    return s.isEmpty ? String(describing: type(of: error)) : String(s.prefix(200))
  }
}

// MARK: backends

/// ScreenCaptureKit, or a fake.
public protocol ScreenCaptureBackend: Sendable {
  /// The displays and the on-screen windows.
  func content() async throws -> ScreenContent
  /// Draws a plan. A display plan with `only` set must draw those windows and nothing else of any app.
  func image(_ plan: CapturePlan) async throws -> CGImage
}

/// CGEvent, or a fake. Each call is one event already allowed by the gate.
public protocol ScreenInputBackend: Sendable {
  func post(_ event: ScreenInputEvent) throws
  /// Setup's live test: proves an event can be posted, and posts nothing an app would notice. Throws when it cannot.
  func probe() throws
}

/// NSWorkspace and the window list, or a fake.
public protocol ScreenAppsBackend: Sendable {
  func runningApps() -> [ScreenApp]
  func frontmost() -> ScreenApp?
  /// What a click at a global point lands on (`ScreenPointWindow.owner`).
  func pointOwner(at point: CGPoint) -> ScreenPointOwner
  /// The pid that really has the keyboard (the system-wide focused element's, else the focused app's); nil when it can't be told.
  func keyboardFocusPID() -> Int32?
  /// True only when the app really has the keyboard although the system-wide focus cannot be read (`LiveScreenApps` lists the checks).
  func appOwnsKeyboard(pid: Int32) -> Bool
  /// True when the app's focused window is a sheet or an open/save panel.
  func frontHasPanel(pid: Int32) -> Bool
  /// The system-wide focused element's text value, when that element belongs to `pid`; nil when it is not readable, not theirs,
  /// or a secure (password) field.
  func focusedValue(pid: Int32) -> String?
  /// The key equivalents of the app's own menus (cmd/ctrl/opt combinations); nil when they cannot be read.
  func menuShortcuts(pid: Int32) -> [ScreenKeyCombo]?
  /// Where the app macOS would open for an id is, nil when none is installed.
  func appPath(bundleID: String) -> String?
  /// Opens exactly the app at `appPath` (the one the gate checked).
  func open(appPath: String) async throws
}

/// The two macOS permissions, checked without asking.
public protocol ScreenPermissionProbe: Sendable {
  func screenRecording() -> Bool
  func accessibility() -> Bool
}
