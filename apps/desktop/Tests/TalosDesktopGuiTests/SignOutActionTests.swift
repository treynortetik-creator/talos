import Foundation
import Testing

@testable import TalosDesktop

/// R1-2: Sign out of the Talos window asks first, and a no does nothing.
@MainActor
@Suite("Sign out asks first", .serialized)
struct SignOutActionTests {
  @Test func aNoSignsNothingOutAndAYesSignsOutOnce() async throws {
    let (askedBefore, performBefore) = (SignOutAction.confirm, SignOutAction.perform)
    defer { (SignOutAction.confirm, SignOutAction.perform) = (askedBefore, performBefore) }
    var asked = 0
    var signedOut = 0
    SignOutAction.perform = { _ in signedOut += 1 }
    SignOutAction.confirm = { asked += 1; return false }
    SignOutAction.run()  // the no is decided on the spot (`guard confirm()`); only perform runs, in a Task
    #expect(asked == 1 && signedOut == 0, "a no signs nothing out")
    SignOutAction.confirm = { asked += 1; return true }
    SignOutAction.run()
    // the perform callback is the signal: yield the main actor to its Task (a bound only, so a yes that never performs fails and does not hang)
    let end = Date().addingTimeInterval(5)
    while signedOut == 0, Date() < end { await Task.yield() }
    for _ in 0..<10 { await Task.yield() }  // a second perform, if there were one, would have run by now
    #expect(asked == 2 && signedOut == 1, "a yes signs out exactly once")
  }
}
