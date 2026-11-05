import AppKit
import Carbon.HIToolbox
import Foundation
import TalosDesktopCore

/// A system-wide hotkey through Carbon `RegisterEventHotKey`: it needs no Accessibility permission (DESKTOP-SPEC 6.3).
@MainActor
final class HotKeys {
  static let shared = HotKeys()

  enum Outcome: Equatable {
    case ok
    /// Another app already owns it.
    case taken
    case failed(Int32)
  }

  var onPress: (() -> Void)?
  private var ref: EventHotKeyRef?
  private(set) var current: HotkeySpec?
  private var handlerInstalled = false

  private func installHandlerOnce() {
    guard !handlerInstalled else { return }
    handlerInstalled = true
    var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    InstallEventHandler(
      GetApplicationEventTarget(),
      { _, _, _ in
        DispatchQueue.main.async { HotKeys.shared.onPress?() }
        return noErr
      }, 1, &spec, nil, nil)
  }

  /// Registers `spec`, replacing the current one only if the new one is accepted: a refused rebind leaves the old
  /// hotkey working.
  @discardableResult
  func register(_ spec: HotkeySpec) -> Outcome {
    if spec == current { return .ok }
    installHandlerOnce()
    var newRef: EventHotKeyRef?
    let id = EventHotKeyID(signature: OSType(0x54_4C_53_48), id: 1)  // 'TLSH'
    // Exclusive: with option 0 Carbon reports a clash only inside this process (measured with two processes). Exclusive
    // makes a combination another app holds exclusively come back as -9878. A holder using plain options stays invisible.
    let status = RegisterEventHotKey(spec.keyCode, spec.modifiers, id, GetApplicationEventTarget(), OptionBits(kEventHotKeyExclusive), &newRef)
    if status == OSStatus(eventHotKeyExistsErr) { return .taken }
    guard status == noErr, let newRef else { return .failed(status) }
    if let old = ref { UnregisterEventHotKey(old) }
    ref = newRef
    current = spec
    return .ok
  }

  func unregister() {
    if let r = ref { UnregisterEventHotKey(r) }
    ref = nil
    current = nil
  }
}

/// The compose hotkey as the owner configured it (`desktop.json` `hotkeys.compose`, default ctrl+opt+space): registers it
/// at launch, rebinds it from the settings view, and tells the owner when another app already has the combination.
@MainActor
final class HotkeyController: ObservableObject {
  static let shared = HotkeyController()
  static let fallback = "ctrl+opt+space"
  static let preSetupKey = "hotkey.compose"

  @Published private(set) var spec: HotkeySpec?
  @Published private(set) var message = ""

  func bootstrap(configured: String) {
    HotKeys.shared.onPress = { QuickCompose.shared.toggle() }
    let wanted = (try? HotkeySpec.parse(configured)) ?? (try? HotkeySpec.parse(Self.fallback))
    guard let wanted else { return }
    apply(wanted, persist: nil)
  }

  /// Rebinds; returns true when the new combination is active. A refused one leaves the old hotkey working.
  @discardableResult
  func apply(_ s: HotkeySpec, persist: ((String) -> Void)?) -> Bool {
    if let sys = SystemHotkeys.holder(of: s) {
      message = "\(s.display) is a macOS shortcut (\(sys)). Your previous hotkey still works."
      return false
    }
    switch HotKeys.shared.register(s) {
    case .ok:
      spec = s
      message = "Active: \(s.display)"
      persist?(s.text)
      return true
    case .taken:
      message = "\(s.display) is already held by another app. Your previous hotkey still works."
      return false
    case .failed(let st):
      message = "Couldn't register \(s.display) (error \(st))."
      return false
    }
  }
}

extension NSEvent.ModifierFlags {
  /// Carbon modifier bits (what `RegisterEventHotKey` takes) from an AppKit event.
  var carbon: UInt32 {
    var m: UInt32 = 0
    if contains(.command) { m |= HotkeySpec.cmd }
    if contains(.shift) { m |= HotkeySpec.shift }
    if contains(.option) { m |= HotkeySpec.opt }
    if contains(.control) { m |= HotkeySpec.ctrl }
    return m
  }
}

/// The enabled shortcuts in macOS's own table (`CopySymbolicHotKeys`: Mission Control, Spotlight, screenshots ...).
enum SystemHotkeys {
  static func holder(of s: HotkeySpec) -> String? {
    var arr: Unmanaged<CFArray>?
    guard CopySymbolicHotKeys(&arr) == noErr, let list = arr?.takeRetainedValue() as? [[String: Any]] else { return nil }
    for e in list {
      guard (e[kHISymbolicHotKeyEnabled as String] as? Bool) == true,
        let code = (e[kHISymbolicHotKeyCode as String] as? NSNumber)?.uint32Value,
        let mods = (e[kHISymbolicHotKeyModifiers as String] as? NSNumber)?.uint32Value
      else { continue }
      if code == s.keyCode, (mods & (HotkeySpec.cmd | HotkeySpec.shift | HotkeySpec.opt | HotkeySpec.ctrl)) == s.modifiers {
        return "an enabled system shortcut"
      }
    }
    return nil
  }
}
