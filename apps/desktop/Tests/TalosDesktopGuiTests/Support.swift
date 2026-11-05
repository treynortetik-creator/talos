import AppKit
import Foundation
import Testing

let guiTestsEnabled = ProcessInfo.processInfo.environment["TALOS_GUI_TESTS"] == "1"

/// One lock for the whole GUI test process. These suites share things a process has only one of: the environment
/// (`HOME`, `PATH` and `TALOS_COMPANION_DIR` are set by fixtures), `NSApplication`, the main run loop, Carbon hot keys,
/// the shared window and pairing singletons. A test that spins the run loop (`RunLoop.main.run`) lets any other suite's
/// queued test start inside the spin, so two suites would change the environment or the windows under each other's feet.
/// Swift Testing runs top-level suites in parallel, and `.serialized` orders only the tests inside one suite, so every
/// top-level GUI suite takes this trait and runs one at a time. Nested suites inherit their parent's slot.
actor GuiLock {
  static let shared = GuiLock()
  private var held = false
  private var waiters: [CheckedContinuation<Void, Never>] = []
  func acquire() async {
    if !held { held = true; return }
    await withCheckedContinuation { waiters.append($0) }
  }
  func release() {
    if waiters.isEmpty { held = false } else { waiters.removeFirst().resume() }
  }
}

struct GuiExclusive: SuiteTrait, TestScoping {
  var isRecursive: Bool { false }
  func provideScope(for test: Test, testCase: Test.Case?, performing function: @Sendable () async throws -> Void) async throws {
    await GuiLock.shared.acquire()
    do { try await function() } catch { await GuiLock.shared.release(); throw error }
    await GuiLock.shared.release()
  }
}

extension SuiteTrait where Self == GuiExclusive {
  static var guiExclusive: GuiExclusive { GuiExclusive() }
}

/// A click, for a test: the button's own action, sent the way a mouse-up inside the button sends it.
/// `NSButton.performClick` is not used: it runs a nested AppKit event loop (`nextEventMatchingMask`), and AppKit ends such
/// a loop with a block on the main run loop that calls `CFRunLoopStop`. When the click finishes first, the block is still
/// queued and the next time the OUTER loop runs it, it stops that loop: the whole test process ends with `exit(0)` in the
/// middle of the run, with no summary and a success status, whichever test happens to be next (found by interposing
/// `CFRunLoopStop` and `exit` under the helper, 2026-11-01).
@MainActor func click(_ b: NSButton) {
  guard b.isEnabled, let action = b.action else { return }
  _ = b.sendAction(action, to: b.target)
}
