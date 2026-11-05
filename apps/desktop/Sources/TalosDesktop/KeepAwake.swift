import AppKit
import Foundation
import IOKit.ps
import IOKit.pwr_mgt

/// "Keep this Mac awake while plugged in" (audit D63). While the switch is on AND the Mac runs on AC power, Talos holds one
/// `PreventUserIdleSystemSleep` assertion, so an idle Mac (the usual cause of "Mac offline") stays awake. It lets go the
/// moment the Mac runs on battery or UPS, when the switch goes off, and when Talos quits. It stops idle sleep only: a
/// closed lid, Sleep from the Apple menu and low battery still sleep the Mac. The display may still turn off.
/// The seams are protocols so the rules are tested without touching the real power system.
protocol PowerSource {
  /// True only for mains power. Battery and UPS are false.
  var onAC: Bool { get }
}

protocol SleepAssertions {
  /// An assertion id, or nil when macOS refused.
  func take(reason: String) -> UInt32?
  func release(_ id: UInt32)
}

@MainActor
final class KeepAwake: ObservableObject {
  enum Status: Equatable {
    case off
    /// On, holding the assertion now.
    case holding
    /// On, but the Mac is on battery: nothing is held.
    case waitingForPower
    /// On and plugged in, but macOS refused the assertion.
    case failed
  }

  static let shared = KeepAwake(power: SystemPower(), assertions: SystemAssertions())
  static let reason = "Talos keeps this Mac awake while it is plugged in"

  @Published private(set) var status: Status = .off
  private(set) var enabled = false
  private var held: UInt32?
  private let power: PowerSource
  private let assertions: SleepAssertions
  private var started = false
  private var terminateObserver: NSObjectProtocol?
  private var powerLoopSource: CFRunLoopSource?

  init(power: PowerSource, assertions: SleepAssertions) {
    self.power = power
    self.assertions = assertions
  }

  /// How many assertions Talos holds right now: 0 or 1, never more.
  var holdsAssertion: Bool { held != nil }

  /// Called once at launch with the saved setting: also starts listening for power changes and for quit.
  func start(enabled: Bool) {
    self.enabled = enabled
    if !started {
      started = true
      terminateObserver = NotificationCenter.default.addObserver(
        forName: NSApplication.willTerminateNotification, object: nil, queue: .main
      ) { [weak self] _ in
        MainActor.assumeIsolated { self?.shutdown() }
      }
      powerLoopSource = SystemPower.watch { [weak self] in Task { @MainActor in self?.powerChanged() } }
    }
    reconcile()
  }

  func setEnabled(_ on: Bool) {
    enabled = on
    reconcile()
  }

  /// The power source changed (plugged in, unplugged).
  func powerChanged() { reconcile() }

  /// Quit: let go for good.
  func shutdown() {
    enabled = false
    reconcile()
    if let s = powerLoopSource {
      CFRunLoopRemoveSource(CFRunLoopGetMain(), s, .defaultMode)
      powerLoopSource = nil
    }
  }

  private func reconcile() {
    let wantHeld = enabled && power.onAC
    if wantHeld {
      if held == nil { held = assertions.take(reason: Self.reason) }
      status = held == nil ? .failed : .holding
    } else {
      if let id = held {
        assertions.release(id)
        held = nil
      }
      status = enabled ? .waitingForPower : .off
    }
  }

  /// The line under the switch in Settings.
  static func caption(_ s: Status) -> String {
    let base = "Stops the Mac from sleeping on its own while it is plugged in. A closed lid, Sleep from the Apple menu and low battery can still put it to sleep."
    switch s {
    case .off, .holding: return base
    case .waitingForPower: return base + " On battery now, so Talos is not holding it awake."
    case .failed: return base + " macOS refused the request just now. Talos will try again when the power changes."
    }
  }
}

struct SystemPower: PowerSource {
  var onAC: Bool {
    guard let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
      let type = IOPSGetProvidingPowerSourceType(info)?.takeUnretainedValue() as String?
    else { return false }  // can't tell: don't hold the Mac awake
    return type == kIOPSACPowerValue
  }

  /// Calls `changed` on the main run loop whenever the power source changes.
  static func watch(_ changed: @escaping @Sendable () -> Void) -> CFRunLoopSource? {
    final class Box { let f: @Sendable () -> Void; init(_ f: @escaping @Sendable () -> Void) { self.f = f } }
    let box = Unmanaged.passRetained(Box(changed))
    guard
      let src = IOPSNotificationCreateRunLoopSource(
        { ctx in
          guard let ctx else { return }
          Unmanaged<Box>.fromOpaque(ctx).takeUnretainedValue().f()
        }, box.toOpaque())?.takeRetainedValue()
    else {
      box.release()
      return nil
    }
    CFRunLoopAddSource(CFRunLoopGetMain(), src, .defaultMode)
    return src
  }
}

struct SystemAssertions: SleepAssertions {
  func take(reason: String) -> UInt32? {
    var id: IOPMAssertionID = 0
    let r = IOPMAssertionCreateWithName(
      kIOPMAssertionTypePreventUserIdleSystemSleep as CFString, IOPMAssertionLevel(kIOPMAssertionLevelOn), reason as CFString, &id)
    return r == kIOReturnSuccess ? id : nil
  }
  func release(_ id: UInt32) { IOPMAssertionRelease(id) }
}
