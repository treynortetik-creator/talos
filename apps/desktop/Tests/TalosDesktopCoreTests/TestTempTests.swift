import Foundation
import TalosTestSupport
import Testing

/// `NSTemporaryDirectory()` ignores TMPDIR on macOS; the tests' own base must not.
@Suite("TestTemp")
struct TestTempTests {
  @Test func anExistingAbsoluteTmpdirIsTheBase() throws {
    let d = NSTemporaryDirectory() + "talos-testtemp-\(UUID().uuidString.prefix(8))"
    try FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(atPath: d) }
    #expect(TestTemp.resolve(d) == d + "/")
    #expect(TestTemp.resolve(d + "/") == d + "/")
  }

  @Test func otherwiseItFallsBackToTheSystemTempFolder() {
    #expect(TestTemp.resolve(nil) == NSTemporaryDirectory())
    #expect(TestTemp.resolve("") == NSTemporaryDirectory())
    #expect(TestTemp.resolve("relative/tmp") == NSTemporaryDirectory())
    #expect(TestTemp.resolve("/no/such/folder-\(UUID().uuidString)") == NSTemporaryDirectory())
  }

  @Test func theBaseFollowsThisRunsTmpdir() {
    #expect(TestTemp.base == TestTemp.resolve(ProcessInfo.processInfo.environment["TMPDIR"]))
  }
}
