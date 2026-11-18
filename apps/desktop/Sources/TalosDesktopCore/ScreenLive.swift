import AppKit
import Carbon
import ApplicationServices
import CoreGraphics
import Foundation
import ScreenCaptureKit

/// The real macOS pieces behind `ScreenCore`. Tests use fakes; only the gated real-capture test calls these.
extension ScreenCore {
  /// `talosHotkeys`: the owner's Talos hotkeys as set now (quick compose, capture); they are never pressed for an agent, nor
  /// any shortcut enabled in this Mac's own table.
  public static func live(
    maxLongEdge: Int = defaultMaxLongEdge, talosHotkeys: @escaping @Sendable () -> [ScreenKeyCombo] = { [] }
  ) -> ScreenCore {
    var c = ScreenCore(
      capture: LiveScreenCapture(), input: LiveScreenInput(), apps: LiveScreenApps(), permissions: LiveScreenPermissions(),
      maxLongEdge: maxLongEdge)
    c.refusedKeys = { talosHotkeys() + SystemShortcuts.enabled() }
    c.layout = { LiveKeyLayout.shared.current() }
    return c
  }
}

/// The shortcuts enabled in macOS's own table (`CopySymbolicHotKeys`: Mission Control, Spotlight, screenshots, input sources
/// and whatever the owner set). Read-only; asks for nothing.
public enum SystemShortcuts {
  public static func enabled() -> [ScreenKeyCombo] {
    var arr: Unmanaged<CFArray>?
    guard CopySymbolicHotKeys(&arr) == noErr, let list = arr?.takeRetainedValue() as? [[String: Any]] else { return [] }
    return list.compactMap { e in
      guard (e[kHISymbolicHotKeyEnabled as String] as? Bool) == true,
        let code = (e[kHISymbolicHotKeyCode as String] as? NSNumber)?.uint32Value, code != 0xFFFF,
        let mods = (e[kHISymbolicHotKeyModifiers as String] as? NSNumber)?.uint32Value
      else { return nil }
      return ScreenKeyGuard.combo(carbonKey: code, carbonModifiers: mods)
    }
  }
}

/// `CGPreflightScreenCaptureAccess` and `AXIsProcessTrusted`: both answer without a prompt.
public struct LiveScreenPermissions: ScreenPermissionProbe {
  public init() {}
  public func screenRecording() -> Bool { CGPreflightScreenCaptureAccess() }
  public func accessibility() -> Bool { AXIsProcessTrusted() }
}

/// ScreenCaptureKit. A filtered plan names its windows one by one (`SCContentFilter(display:including:)`), so anything not
/// named is not drawn; a named window is drawn only if its id, owner bundle id and owner pid all still match.
public struct LiveScreenCapture: ScreenCaptureBackend {
  public init() {}

  public enum Failure: Error, LocalizedError {
    case displayGone(UInt32), windowGone(UInt32)
    public var errorDescription: String? {
      switch self {
      case .displayGone(let id): return "display \(id) went away"
      case .windowGone(let id): return "window \(id) closed"
      }
    }
  }

  public func content() async throws -> ScreenContent {
    let c = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    return ScreenContent(
      displays: c.displays.map { ScreenDisplay(id: $0.displayID, frame: $0.frame) },
      windows: c.windows.map(Self.window), mainDisplayID: CGMainDisplayID())
  }

  static func window(_ w: SCWindow) -> ScreenWindow {
    let b = w.owningApplication?.bundleIdentifier
    return ScreenWindow(
      id: w.windowID, ownerBundleID: (b?.isEmpty ?? true) ? nil : b, ownerPID: w.owningApplication?.processID ?? -1,
      frame: w.frame, layer: w.windowLayer, isOnScreen: w.isOnScreen)
  }

  public func image(_ plan: CapturePlan) async throws -> CGImage {
    let c = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    let filter: SCContentFilter
    switch plan.source {
    case .display(let id, let only):
      guard let d = c.displays.first(where: { $0.displayID == id }) else { throw Failure.displayGone(id) }
      if let only {
        let picked = c.windows.filter { w in only.contains { $0.matches(Self.window(w)) } }
        filter = SCContentFilter(display: d, including: picked)
        if #available(macOS 14.2, *) { filter.includeMenuBar = false }
      } else {
        filter = SCContentFilter(display: d, excludingWindows: [])
        if #available(macOS 14.2, *) { filter.includeMenuBar = true }
      }
    case .window(let p):
      guard let w = c.windows.first(where: { p.matches(Self.window($0)) }) else { throw Failure.windowGone(p.id) }
      filter = SCContentFilter(desktopIndependentWindow: w)
    }
    let scale = CGFloat(filter.pointPixelScale)
    let rect = plan.crop ?? CGRect(origin: .zero, size: filter.contentRect.size)
    let cfg = SCStreamConfiguration()
    if let crop = plan.crop { cfg.sourceRect = crop }
    cfg.width = max(1, Int((rect.width * scale).rounded()))
    cfg.height = max(1, Int((rect.height * scale).rounded()))
    cfg.showsCursor = false
    cfg.colorSpaceName = CGColorSpace.sRGB
    cfg.capturesAudio = false
    return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
  }
}

/// CGEvent, posted to the HID tap.
public struct LiveScreenInput: ScreenInputBackend {
  public init() {}

  public enum Failure: Error, LocalizedError {
    case noEvent
    public var errorDescription: String? { "macOS would not make the event" }
  }

  /// macOS's own read-only check that this process may post events (no prompt), then one pointer move to where the pointer
  /// already is: the event goes through the same tap as a real click and nothing on screen changes.
  public func probe() throws {
    guard CGPreflightPostEventAccess() else { throw ScreenRefusal.accessibilityNotGranted }
    guard let here = CGEvent(source: nil)?.location,
      let move = CGEvent(
        mouseEventSource: CGEventSource(stateID: .hidSystemState), mouseType: .mouseMoved, mouseCursorPosition: here, mouseButton: .left)
    else { throw Failure.noEvent }
    move.post(tap: .cghidEventTap)
  }

  public func post(_ event: ScreenInputEvent) throws { try post(event, token: 0) }

  /// Every CGEvent carries `token` in its user data (`SyntheticInput`), so each window that receives one knows it is an agent's, which
  /// request it belongs to, and answers it. The ones a window answers (`ScreenInputEvent.answers`): a release, a key-up, a scroll.
  public func post(_ event: ScreenInputEvent, token: Int64) throws {
    let src = CGEventSource(stateID: .hidSystemState)
    switch event {
    case .click(let p, let button, let count):
      let (down, up, b): (CGEventType, CGEventType, CGMouseButton) =
        switch button {
        case .left: (.leftMouseDown, .leftMouseUp, .left)
        case .right: (.rightMouseDown, .rightMouseUp, .right)
        case .middle: (.otherMouseDown, .otherMouseUp, .center)
        }
      // one down/up pair; `count` is its click state (2 is the second click of a double-click). The pointer moves on the first.
      if count <= 1 {
        guard let move = CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: b) else {
          throw Failure.noEvent
        }
        Self.post(move, token)
      }
      guard let d = CGEvent(mouseEventSource: src, mouseType: down, mouseCursorPosition: p, mouseButton: b),
        let u = CGEvent(mouseEventSource: src, mouseType: up, mouseCursorPosition: p, mouseButton: b)
      else { throw Failure.noEvent }
      d.setIntegerValueField(.mouseEventClickState, value: Int64(max(1, count)))
      u.setIntegerValueField(.mouseEventClickState, value: Int64(max(1, count)))
      Self.post(d, token)
      Self.post(u, token)
    case .text(let s):
      try postUnicode(s, src, token)
    case .keys(let ks):
      // each one the key press screen_key posts
      for k in ks { try postKey(k, src, token) }
    case .key(let k):
      try postKey(k, src, token)
    case .scroll(let p, let dx, let dy):
      guard let move = CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left),
        let s = CGEvent(
          scrollWheelEvent2Source: src, units: .pixel, wheelCount: 2, wheel1: Int32(dy), wheel2: Int32(dx), wheel3: 0)
      else { throw Failure.noEvent }
      Self.post(move, token)
      s.location = p
      Self.post(s, token)
    }
  }

  private func postKey(_ k: ScreenKeyCombo, _ src: CGEventSource?, _ token: Int64) throws {
    guard let d = CGEvent(keyboardEventSource: src, virtualKey: k.keyCode, keyDown: true),
      let u = CGEvent(keyboardEventSource: src, virtualKey: k.keyCode, keyDown: false)
    else { throw Failure.noEvent }
    d.flags = CGEventFlags(rawValue: k.flags)
    u.flags = CGEventFlags(rawValue: k.flags)
    Self.post(d, token)
    Self.post(u, token)
  }

  private func postUnicode(_ text: String, _ src: CGEventSource?, _ token: Int64) throws {
    let units = Array(text.utf16)
    guard let d = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true),
      let u = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false)
    else { throw Failure.noEvent }
    d.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
    u.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
    Self.post(d, token)
    Self.post(u, token)
  }

  private static func post(_ e: CGEvent, _ token: Int64) {
    e.setIntegerValueField(.eventSourceUserData, value: token)
    e.post(tap: .cghidEventTap)
  }
}

/// NSWorkspace for the apps, the CoreGraphics window list for what is under the pointer (bounds and owner pid need no
/// permission).
public struct LiveScreenApps: ScreenAppsBackend {
  public init() {}

  public enum Failure: Error, LocalizedError {
    case notInstalled(String)
    public var errorDescription: String? {
      switch self { case .notInstalled(let id): return "no app with the id \(id) is installed" }
    }
  }

  static func app(_ r: NSRunningApplication) -> ScreenApp {
    ScreenApp(bundleID: r.bundleIdentifier, pid: r.processIdentifier, name: r.localizedName ?? r.bundleIdentifier ?? "an app")
  }

  public func runningApps() -> [ScreenApp] {
    NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }.map(Self.app)
  }

  public func frontmost() -> ScreenApp? { NSWorkspace.shared.frontmostApplication.map(Self.app) }

  /// What a click at `point` lands on: the window the server hits, looked up in the on-screen window list (`windowList()`, front to
  /// back, menu bar extras and invisible windows included); bounds and owner need no permission.
  public func pointOwner(at point: CGPoint) -> ScreenPointOwner {
    // the hit first, the list after: a window that appears in between is then in the list, never missing from it
    let hit = Self.windowServerHit(at: point)
    guard let windows = Self.windowList() else { return .nothing }
    return ScreenPointWindow.owner(at: point, in: windows, hit: hit)
  }

  /// The window the window server would hand a click at this global point (top-left origin) to: 0 when there is none, nil when it
  /// could not be asked in time. It is the server's own answer, so a window that ignores the mouse is skipped and one that takes
  /// it is named, whatever its alpha says. It needs no Screen Recording. AppKit answers on the main thread; a caller on another
  /// thread (the socket's) hops there and waits at most `hitTimeout`, then fails closed.
  static func windowServerHit(at p: CGPoint) -> UInt32? {
    let ask: @Sendable () -> UInt32? = {
      guard let top = NSScreen.screens.first?.frame.height else { return nil }
      let n = NSWindow.windowNumber(at: NSPoint(x: p.x, y: top - p.y), belowWindowWithWindowNumber: 0)
      return n > 0 ? UInt32(n) : 0
    }
    if Thread.isMainThread { return ask() }
    let answer = LockedValue<UInt32?>(nil)
    let done = DispatchSemaphore(value: 0)
    DispatchQueue.main.async {
      answer.value = ask()
      done.signal()
    }
    guard done.wait(timeout: .now() + hitTimeout) == .success else { return nil }
    return answer.value
  }

  /// The pid of the real Dock: the running app whose bundle is the system's Dock.app (a protected path, so another app cannot be
  /// there). nil when it is not found, which skips nothing.
  static func realDockPID() -> Int32? {
    NSWorkspace.shared.runningApplications.first {
      $0.bundleURL?.resolvingSymlinksInPath().path == "/System/Library/CoreServices/Dock.app"
    }?.processIdentifier
  }

  /// How long the main thread gets to answer a hit test before the point is refused.
  static let hitTimeout: TimeInterval = 2

  /// The window server's on-screen list, front to back (`optionAll` is not in stacking order: it lists Terminal at level 0 ahead of
  /// the Dock's level 20 window); nil when it cannot be read. Invisible windows and menu bar extras are in it.
  static func windowList() -> [ScreenPointWindow]? {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else { return nil }
    return list.compactMap { w in
      guard let b = w[kCGWindowBounds as String] as? NSDictionary, let r = CGRect(dictionaryRepresentation: b as CFDictionary),
        let pid = (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value
      else { return nil }
      let run = NSRunningApplication(processIdentifier: pid)
      return ScreenPointWindow(
        pid: pid, name: run?.localizedName ?? (w[kCGWindowOwnerName as String] as? String) ?? "an app", bundleID: run?.bundleIdentifier,
        bounds: r, layer: (w[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0,
        alpha: (w[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1,
        onScreen: (w[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false,
        windowID: (w[kCGWindowNumber as String] as? NSNumber)?.uint32Value ?? 0)
    }
  }

  /// The system-wide focused element's pid (where typing goes), else the focused application's. Needs Accessibility; nil
  /// without it or when nothing has focus.
  public func keyboardFocusPID() -> Int32? {
    let sys = AXUIElementCreateSystemWide()
    for attr in [kAXFocusedUIElementAttribute, kAXFocusedApplicationAttribute] {
      var v: CFTypeRef?
      guard AXUIElementCopyAttributeValue(sys, attr as CFString, &v) == .success, let v, CFGetTypeID(v) == AXUIElementGetTypeID()
      else { continue }
      var pid: pid_t = 0
      // swiftlint:disable:next force_cast
      if AXUIElementGetPid(v as! AXUIElement, &pid) == .success, pid > 0 { return pid }
    }
    return nil
  }

  /// Whether the app really has the keyboard, for when the system-wide focus cannot be read (an app with no window open). All of
  /// these must hold, and any read that fails counts as false (it fails closed): (1) secure event input is off (a password or Touch
  /// ID sheet turns it on); (2) the app's own AX element answers `kAXFocusedWindowAttribute` with a window of that same pid, and
  /// that window reads focused or main (`kAXFocusedAttribute` / `kAXMainAttribute`, either true); (3) the topmost on-screen
  /// window at layers 0-23 with alpha above 0 and at least 40 by 40 points (so not an invisible sliver such as a notification
  /// helper's) belongs to the app (`ScreenPointWindow.topVisibleAppPID`).
  public func appOwnsKeyboard(pid: Int32) -> Bool {
    guard !IsSecureEventInputEnabled() else { return false }
    func attr(_ e: AXUIElement, _ name: String) -> CFTypeRef? {
      var v: CFTypeRef?
      return AXUIElementCopyAttributeValue(e, name as CFString, &v) == .success ? v : nil
    }
    guard let w = attr(AXUIElementCreateApplication(pid), kAXFocusedWindowAttribute), CFGetTypeID(w) == AXUIElementGetTypeID() else {
      return false
    }
    // swiftlint:disable:next force_cast
    let win = w as! AXUIElement
    var owner: pid_t = 0
    guard AXUIElementGetPid(win, &owner) == .success, owner == pid else { return false }
    let key = [kAXFocusedAttribute, kAXMainAttribute].contains { (attr(win, $0) as? Bool) == true }
    guard key, let list = Self.windowList() else { return false }
    return ScreenPointWindow.topVisibleAppPID(in: list, realDockPID: Self.realDockPID(), screenSizes: NSScreen.screens.map(\.frame.size)) == pid
  }

  /// Whether the app's focused window is a sheet (role AXSheet, or it has an AXSheet child) or a dialog (subrole AXDialog or
  /// AXSystemDialog), which is where an open or save panel is.
  public func frontHasPanel(pid: Int32) -> Bool {
    func attr(_ e: AXUIElement, _ name: String) -> CFTypeRef? {
      var v: CFTypeRef?
      return AXUIElementCopyAttributeValue(e, name as CFString, &v) == .success ? v : nil
    }
    guard let w = attr(AXUIElementCreateApplication(pid), kAXFocusedWindowAttribute), CFGetTypeID(w) == AXUIElementGetTypeID() else {
      return false
    }
    // swiftlint:disable:next force_cast
    let win = w as! AXUIElement
    if attr(win, kAXRoleAttribute) as? String == kAXSheetRole { return true }
    if let sub = attr(win, kAXSubroleAttribute) as? String, sub == kAXDialogSubrole || sub == kAXSystemDialogSubrole { return true }
    let kids = attr(win, kAXChildrenAttribute) as? [AXUIElement] ?? []
    return kids.contains { attr($0, kAXRoleAttribute) as? String == kAXSheetRole }
  }

  /// The system-wide focused element's `kAXValueAttribute` as text, when the element belongs to `pid`.
  public func focusedField(pid: Int32) -> ScreenField? {
    var f: CFTypeRef?
    guard AXUIElementCopyAttributeValue(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute as CFString, &f) == .success,
      let f, CFGetTypeID(f) == AXUIElementGetTypeID()
    else { return nil }
    // swiftlint:disable:next force_cast
    let el = f as! AXUIElement
    var owner: pid_t = 0
    guard AXUIElementGetPid(el, &owner) == .success, owner == pid else { return nil }
    var sub: CFTypeRef?
    if AXUIElementCopyAttributeValue(el, kAXSubroleAttribute as CFString, &sub) == .success,
      sub as? String == kAXSecureTextFieldSubrole as String
    { return nil }
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, kAXValueAttribute as CFString, &v) == .success, let text = v as? String else { return nil }
    return ScreenField(element: Int(bitPattern: CFHash(el)), value: text)
  }

  /// The key equivalents in the app's menu bar (`AXMenuItemCmdChar` / `CmdVirtualKey` / `CmdModifiers`), at most 4 menus deep and
  /// 2,000 items. nil when the menu bar cannot be read.
  public func menuShortcuts(pid: Int32) -> [ScreenKeyCombo]? {
    let app = AXUIElementCreateApplication(pid)
    guard let bar = Self.element(app, kAXMenuBarAttribute) else { return nil }
    return MenuWalk.shortcuts(
      bar: bar, children: Self.children, role: { Self.string($0, kAXRoleAttribute) }, shortcut: Self.shortcut)
  }

  static func string(_ e: AXUIElement, _ attr: String) -> String? {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(e, attr as CFString, &v) == .success else { return nil }
    return v as? String
  }

  static func element(_ e: AXUIElement, _ attr: String) -> AXUIElement? {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(e, attr as CFString, &v) == .success, let v, CFGetTypeID(v) == AXUIElementGetTypeID() else {
      return nil
    }
    return (v as! AXUIElement)  // swiftlint:disable:this force_cast
  }

  static func children(_ e: AXUIElement) -> [AXUIElement] {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(e, kAXChildrenAttribute as CFString, &v) == .success, let list = v as? [AnyObject] else { return [] }
    return list.compactMap { CFGetTypeID($0) == AXUIElementGetTypeID() ? ($0 as! AXUIElement) : nil }  // swiftlint:disable:this force_cast
  }

  /// One menu item's key equivalent as a combination: the AX modifier bits are shift 1, option 2, control 4, and 8 for "no
  /// command" (command is on unless that bit is set).
  static func shortcut(_ e: AXUIElement) -> ScreenKeyCombo? {
    var c: CFTypeRef?
    var k: CFTypeRef?
    var m: CFTypeRef?
    AXUIElementCopyAttributeValue(e, kAXMenuItemCmdCharAttribute as CFString, &c)
    AXUIElementCopyAttributeValue(e, kAXMenuItemCmdVirtualKeyAttribute as CFString, &k)
    AXUIElementCopyAttributeValue(e, kAXMenuItemCmdModifiersAttribute as CFString, &m)
    let ch = (c as? String)?.lowercased() ?? ""
    let code: UInt16
    if !ch.isEmpty, let kc = HotkeySpec.keys[ch] {
      code = UInt16(kc)
    } else if let v = (k as? NSNumber)?.intValue, v > 0, v < 0x80 {
      code = UInt16(v)
    } else {
      return nil
    }
    let bits = (m as? NSNumber)?.intValue ?? 0
    var flags: UInt64 = bits & 8 == 0 ? ScreenKeyCombo.cmd : 0
    if bits & 1 != 0 { flags |= ScreenKeyCombo.shift }
    if bits & 2 != 0 { flags |= ScreenKeyCombo.opt }
    if bits & 4 != 0 { flags |= ScreenKeyCombo.ctrl }
    return ScreenKeyCombo(keyCode: code, flags: flags)
  }

  public func appPath(bundleID: String) -> String? {
    NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID)?.path
  }

  public func open(appPath: String) async throws {
    guard FileManager.default.fileExists(atPath: appPath) else { throw Failure.notInstalled(appPath) }
    _ = try await NSWorkspace.shared.openApplication(
      at: URL(fileURLWithPath: appPath), configuration: NSWorkspace.OpenConfiguration())
  }
}

/// The walk over an app's menu bar for its key equivalents, apart from Accessibility so it can be tested. Depth counts MENUS (each
/// `AXMenu` opened), up to `maxMenus`: Edit > Find > Find… is two. The application menu's own submenus (Services: shortcuts of
/// other apps) are not read.
public enum MenuWalk {
  public static let maxMenus = 4
  public static let maxElements = 4000

  public static func shortcuts<N>(
    bar: N, children: (N) -> [N], role: (N) -> String?, shortcut: (N) -> ScreenKeyCombo?
  ) -> [ScreenKeyCombo] {
    var out: [ScreenKeyCombo] = []
    var seen = 0
    func walk(_ n: N, menus: Int, inAppMenu: Bool) {
      guard seen < maxElements else { return }
      seen += 1
      if let c = shortcut(n) { out.append(c) }
      for k in children(n) {
        if role(k) == "AXMenu" {
          // a menu inside the application menu is Services (or a list like it): another app's shortcuts
          if inAppMenu && menus >= 1 { continue }
          guard menus < maxMenus else { continue }
          walk(k, menus: menus + 1, inAppMenu: inAppMenu)
        } else {
          walk(k, menus: menus, inAppMenu: inAppMenu)
        }
      }
    }
    for (i, top) in children(bar).enumerated() { walk(top, menus: 0, inAppMenu: i == 0) }
    return out
  }
}
