import ApplicationServices
import CoreGraphics
import Foundation

/// The two real prompts behind Setup's Grant buttons. Only the buttons call these; tests use a fake.
public struct LiveScreenGrants: ScreenGrantActions {
  public init() {}
  public func requestScreenRecording() -> Bool { CGRequestScreenCaptureAccess() }
  public func requestAccessibility() -> Bool {
    let key = "AXTrustedCheckOptionPrompt"  // kAXTrustedCheckOptionPrompt's value (the constant is a global var Swift 6 will not read)
    return AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
  }
}
