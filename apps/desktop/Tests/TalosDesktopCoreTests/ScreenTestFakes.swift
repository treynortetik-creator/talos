import CoreGraphics
import Foundation
import ImageIO
@testable import TalosDesktopCore

/// An RGB colour, 0-255 a channel.
struct RGB: Equatable, Hashable, CustomStringConvertible {
  var r: UInt8, g: UInt8, b: UInt8
  static let magenta = RGB(r: 255, g: 0, b: 255)
  static let wallpaper = RGB(r: 0, g: 160, b: 0)
  static let allowed = RGB(r: 0, g: 0, b: 255)
  static let other = RGB(r: 255, g: 200, b: 0)
  static let black = RGB(r: 0, g: 0, b: 0)
  var description: String { String(format: "#%02X%02X%02X", r, g, b) }
}

/// A small window server: it lists `content` and draws a plan the way ScreenCaptureKit does. A display plan with `only` draws
/// only the windows whose id and owner still match (the rest black, as SCK leaves a gap); `nil` draws everything. Scale 1.
/// `content` can change between the listing and the drawing, like the real screen.
final class FakeCapture: ScreenCaptureBackend, @unchecked Sendable {
  private let lock = NSLock()
  private var _content: ScreenContent
  private var _colours: [UInt32: RGB]
  private var _plans: [CapturePlan] = []
  private var _contentCalls = 0
  var listError: (any Error)?
  var drawError: (any Error)?
  /// Runs after the listing and before the drawing: the screen changing under a capture.
  var betweenListAndDraw: (@Sendable (FakeCapture) -> Void)?

  init(_ content: ScreenContent, colours: [UInt32: RGB]) {
    _content = content
    _colours = colours
  }

  var content: ScreenContent {
    get { lock.withLock { _content } }
    set { lock.withLock { _content = newValue } }
  }
  func setColour(_ id: UInt32, _ c: RGB) { lock.withLock { _colours[id] = c } }
  var plans: [CapturePlan] { lock.withLock { _plans } }
  var contentCalls: Int { lock.withLock { _contentCalls } }

  func content() async throws -> ScreenContent {
    lock.withLock { _contentCalls += 1 }
    if let listError { throw listError }
    return content
  }

  func image(_ plan: CapturePlan) async throws -> CGImage {
    lock.withLock { _plans.append(plan) }
    betweenListAndDraw?(self)
    if let drawError { throw drawError }
    let (c, colours) = lock.withLock { (_content, _colours) }
    let origin: CGPoint
    let size: CGSize
    var draw: [ScreenWindow]
    switch plan.source {
    case .display(let id, let only):
      guard let d = c.displays.first(where: { $0.id == id }) else { throw LiveScreenCapture.Failure.displayGone(id) }
      origin = d.frame.origin
      size = d.frame.size
      // The list is front to back; draw back to front.
      draw = c.windows.reversed().filter { w in only.map { o in o.contains { $0.matches(w) } } ?? true }
    case .window(let p):
      guard let w = c.windows.first(where: { p.matches($0) }) else { throw LiveScreenCapture.Failure.windowGone(p.id) }
      origin = w.frame.origin
      size = w.frame.size
      draw = [w]
    }
    let crop = plan.crop ?? CGRect(origin: .zero, size: size)
    let ctx = try bitmap(Int(crop.width), Int(crop.height))
    ctx.setFillColor(CGColor(srgbRed: 0, green: 0, blue: 0, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: crop.width, height: crop.height))
    for w in draw where w.isOnScreen {
      let col = colours[w.id] ?? .other
      ctx.setFillColor(CGColor(srgbRed: CGFloat(col.r) / 255, green: CGFloat(col.g) / 255, blue: CGFloat(col.b) / 255, alpha: 1))
      // To crop-local, top-left origin, then flip for CoreGraphics' bottom-left
      let local = w.frame.offsetBy(dx: -origin.x - crop.minX, dy: -origin.y - crop.minY)
      ctx.fill(CGRect(x: local.minX, y: crop.height - local.maxY, width: local.width, height: local.height))
    }
    guard let img = ctx.makeImage() else { throw ScreenRefusal.captureFailed("fake") }
    return img
  }
}

func bitmap(_ w: Int, _ h: Int) throws -> CGContext {
  guard let space = CGColorSpace(name: CGColorSpace.sRGB),
    let ctx = CGContext(
      data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: space,
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
  else { throw ScreenRefusal.captureFailed("no bitmap") }
  return ctx
}

/// Every pixel of an image as RGB, drawn into sRGB.
func pixels(_ image: CGImage) throws -> [RGB] {
  let w = image.width
  let h = image.height
  let ctx = try bitmap(w, h)
  ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
  guard let data = ctx.data else { return [] }
  let p = data.bindMemory(to: UInt8.self, capacity: w * h * 4)
  return (0..<(w * h)).map { i in RGB(r: p[i * 4], g: p[i * 4 + 1], b: p[i * 4 + 2]) }
}

func decodePNG(_ d: Data) -> CGImage? {
  guard let src = CGImageSourceCreateWithData(d as CFData, nil) else { return nil }
  return CGImageSourceCreateImageAtIndex(src, 0, nil)
}

/// Near a colour (within `slack` on every channel): colour management moves real captures a little.
func near(_ a: RGB, _ b: RGB, slack: Int = 40) -> Bool {
  abs(Int(a.r) - Int(b.r)) <= slack && abs(Int(a.g) - Int(b.g)) <= slack && abs(Int(a.b) - Int(b.b)) <= slack
}

func colours(of shot: ScreenShot) throws -> Set<RGB> {
  guard let img = decodePNG(shot.png) else { throw ScreenRefusal.encodeFailed("not a PNG") }
  return Set(try pixels(img))
}

final class FakeInput: ScreenInputBackend, @unchecked Sendable {
  private let lock = NSLock()
  private var _posted: [ScreenInputEvent] = []
  private var _probes = 0
  var error: (any Error)?
  var probeError: (any Error)?
  var probes: Int { lock.withLock { _probes } }
  func probe() throws {
    if let probeError { throw probeError }
    lock.withLock { _probes += 1 }
  }
  /// Runs after each post: the world reacting to the event.
  var after: (@Sendable (Int) -> Void)?
  var posted: [ScreenInputEvent] { lock.withLock { _posted } }
  func post(_ event: ScreenInputEvent) throws {
    if let error { throw error }
    let n = lock.withLock {
      _posted.append(event)
      return _posted.count
    }
    after?(n)
  }
}

final class FakeApps: ScreenAppsBackend, @unchecked Sendable {
  private let lock = NSLock()
  private var _front: ScreenApp?
  private var _opened: [String] = []
  var running: [ScreenApp] = []
  /// The app under each point; a point not listed has nothing under it.
  var under: (@Sendable (CGPoint) -> ScreenApp?) = { _ in nil }
  var openError: (any Error)?
  /// Where the keyboard really is (the system-wide focused element's pid). Default: the front app's.
  var focus: (@Sendable () -> Int32?)?
  /// The front app's own menu key equivalents. Default: a few common ones (`Fx.menu`); nil: they cannot be read.
  var menu: [ScreenKeyCombo]? = Fx.menu
  /// Whether the app provably owns the keyboard when no focus can be read (default true).
  var ownsKeyboard: @Sendable (Int32) -> Bool = { _ in true }
  /// Whether the app's focused window is a sheet or an open/save panel (default false).
  var hasPanel: @Sendable (Int32) -> Bool = { _ in false }
  /// Runs at the start of each `frontmost()` call with its number (1 for the first): the world changing between checks.
  var onFrontmost: (@Sendable (Int) -> Void)?
  private var _frontCalls = 0
  /// The focused field's value (default nil: not readable).
  var value: @Sendable (Int32) -> String? = { _ in nil }
  init(front: ScreenApp?) { _front = front }
  func keyboardFocusPID() -> Int32? { focus.map { $0() } ?? front?.pid }
  func appOwnsKeyboard(pid: Int32) -> Bool { ownsKeyboard(pid) }
  func frontHasPanel(pid: Int32) -> Bool { hasPanel(pid) }
  func focusedValue(pid: Int32) -> String? { value(pid) }
  func menuShortcuts(pid: Int32) -> [ScreenKeyCombo]? { menu }
  var front: ScreenApp? {
    get { lock.withLock { _front } }
    set { lock.withLock { _front = newValue } }
  }
  var opened: [String] { lock.withLock { _opened } }
  func runningApps() -> [ScreenApp] { running }
  func frontmost() -> ScreenApp? {
    let n = lock.withLock { () -> Int in
      _frontCalls += 1
      return _frontCalls
    }
    onFrontmost?(n)
    return front
  }
  /// Points that are the menu bar or another system window.
  var systemArea: (@Sendable (CGPoint) -> Bool) = { _ in false }
  /// A full answer for a point, when a test needs one `under` cannot give (a user-visible owner such as another app's invisible window).
  var owner: (@Sendable (CGPoint) -> ScreenPointOwner)?
  func pointOwner(at point: CGPoint) -> ScreenPointOwner {
    if systemArea(point) { return .systemArea }
    if let owner { return owner(point) }
    return under(point).map { .app($0) } ?? .nothing
  }
  /// Installed apps by id (default: every id is installed at `/Apps/<id>.app`). Set an id to nil for "not installed".
  var installed: [String: String?] = [:]
  func appPath(bundleID: String) -> String? {
    if let p = installed[bundleID] { return p }
    return "/Apps/\(bundleID).app"
  }
  /// `opened` records the bundle id of `/Apps/<id>.app`, or the path itself for any other path.
  func open(appPath: String) async throws {
    if let openError { throw openError }
    let id = appPath.hasPrefix("/Apps/") && appPath.hasSuffix(".app") ? String(appPath.dropFirst(6).dropLast(4)) : appPath
    lock.withLock { _opened.append(id) }
  }
}

/// A signature check for tests: by default every running pid and every app path passes its entry's check (lane 1-2's rules are
/// about bundle ids and gaps); `refusePIDs` and `refusePaths` fail it, `lookups` say what an app measures as.
final class FakeSigning: ScreenCodeSigning, @unchecked Sendable {
  var refusePIDs: Set<Int32> = []
  var refusePaths: Set<String> = []
  /// Pids that are not Apple's code (every other pid is).
  var notApple: Set<Int32> = []
  /// The ids each pid's code really carries (default: whatever is claimed).
  var realIDs: [Int32: String] = [:]
  func isApple(pid: Int32, identifier: String) -> Bool { !notApple.contains(pid) && (realIDs[pid] ?? identifier) == identifier }
  var lookups: [Int32: ScreenCodeLookup] = [:]
  var pathLookups: [String: ScreenCodeLookup] = [:]
  private let lock = NSLock()
  private var _checks: [Int32] = []
  var checks: [Int32] { lock.withLock { _checks } }
  init() {}
  func lookup(pid: Int32) -> ScreenCodeLookup { lookups[pid] ?? .gone }
  func lookup(appPath: String) -> ScreenCodeLookup { pathLookups[appPath] ?? .gone }
  func matches(pid: Int32, app: ScreenAllowedApp) -> Bool {
    lock.withLock { _checks.append(pid) }
    return !refusePIDs.contains(pid)
  }
  func matches(appPath: String, app: ScreenAllowedApp) -> Bool { !refusePaths.contains(appPath) }
}

/// Lane 1-2's tests name the list by bundle ids: the same rules with every signature passing.
extension ScreenAllowed {
  static func ids(_ ids: Set<String>, signing: any ScreenCodeSigning = FakeSigning()) -> ScreenAllowed {
    ScreenAllowed(apps: ids.map { ScreenAllowedApp(bundleID: $0) }, signing: signing)
  }
}

extension ScreenCore {
  func agentCapture(allowedBundleIDs: Set<String>, area: ScreenArea = .full) async throws(ScreenRefusal) -> ScreenShot {
    try await agentCapture(allowed: .ids(allowedBundleIDs), area: area)
  }
  @discardableResult
  func perform(_ request: ScreenInputRequest, allowedBundleIDs: Set<String>) throws(ScreenRefusal) -> Int {
    try perform(request, allowed: .ids(allowedBundleIDs))
  }
  func openApp(bundleID: String, allowedBundleIDs: Set<String>) async throws(ScreenRefusal) {
    try await openApp(bundleID: bundleID, allowed: .ids(allowedBundleIDs))
  }
}

struct FakePermissions: ScreenPermissionProbe {
  var screen = true
  var ax = true
  func screenRecording() -> Bool { screen }
  func accessibility() -> Bool { ax }
}

struct Boom: Error, LocalizedError {
  var text = "boom"
  var errorDescription: String? { text }
}

/// Apps used across the screen tests. Ids are made up, except the macOS ones the desktop rule names.
enum Fx {
  static let notes = ScreenApp(bundleID: "com.example.notes", pid: 501, name: "Notes Example")
  static let secret = ScreenApp(bundleID: "com.example.secret", pid: 502, name: "Secret Example")
  static let talos = ScreenApp(bundleID: ScreenCore.talosBundleID, pid: 777, name: "Talos")
  static let selfPID: Int32 = 900
  /// The menu shortcuts the fake front app has: cmd+s/c/v/w/n/a/q and cmd+shift+t.
  static let menu: [ScreenKeyCombo] = ["cmd+s", "cmd+c", "cmd+v", "cmd+w", "cmd+n", "cmd+a", "cmd+shift+t", "cmd+q"].map {
    try! ScreenKeyCombo.parse($0)
  }
  static let display = ScreenDisplay(id: 1, frame: CGRect(x: 0, y: 0, width: 400, height: 300))
  static let wallpaper = ScreenWindow(
    id: 10, ownerBundleID: "com.apple.dock", ownerPID: 90, frame: display.frame, layer: -2_147_483_624)
  /// The allowed app, behind.
  static let notesWindow = ScreenWindow(id: 20, ownerBundleID: "com.example.notes", ownerPID: 501, frame: CGRect(x: 20, y: 20, width: 200, height: 150))
  /// The ungranted app, in front and overlapping the allowed one.
  static let secretWindow = ScreenWindow(id: 30, ownerBundleID: "com.example.secret", ownerPID: 502, frame: CGRect(x: 150, y: 100, width: 200, height: 150))

  static func content() -> ScreenContent {
    ScreenContent(displays: [display], windows: [secretWindow, notesWindow, wallpaper], mainDisplayID: 1)
  }
  static let colours: [UInt32: RGB] = [10: .wallpaper, 20: .allowed, 30: .magenta]

  static func core(
    capture: FakeCapture = FakeCapture(content(), colours: colours), input: FakeInput = FakeInput(),
    apps: FakeApps = FakeApps(front: notes), permissions: FakePermissions = FakePermissions(), maxLongEdge: Int = 4096
  ) -> ScreenCore {
    ScreenCore(
      capture: capture, input: input, apps: apps, permissions: permissions, selfBundleID: "app.talos.desktop.dev",
      selfPID: selfPID, maxLongEdge: maxLongEdge)
  }
}
