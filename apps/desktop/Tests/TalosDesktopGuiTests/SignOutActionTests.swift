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
    SignOutAction.run()
    try await Task.sleep(nanoseconds: 150_000_000)
    #expect(asked == 1 && signedOut == 0, "a no signs nothing out")
    SignOutAction.confirm = { asked += 1; return true }
    SignOutAction.run()
    try await Task.sleep(nanoseconds: 150_000_000)
    #expect(asked == 2 && signedOut == 1, "a yes signs out exactly once")
  }
}
