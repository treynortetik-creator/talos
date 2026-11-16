import Foundation
import TalosDesktopCore
import TalosSupervisor
import TalosTestSupport
import Testing

/// Unix socket paths are limited to 104 bytes on macOS, 103 usable (the last is the terminating NUL). CI points TMPDIR at
/// a long folder under ~/.cache, and the rig's temp folder follows it (`TestTemp`), so a socket made inside that folder
/// could pass the limit. The rig's tmux socket must stay on its short /tmp base whatever TMPDIR says.
@Suite("Test temp folders and sockets", .serialized, .enabled(if: Rig.hasTmux))
struct TestTempSocketTests {
  static let maxSocketPath = 103

  @Test func theRigsTmuxSocketStaysShortUnderALongTmpdir() throws {
    let long = TestTemp.base + "talos-long-tmpdir-" + String(repeating: "x", count: 100)
    try FileManager.default.createDirectory(atPath: long, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(atPath: long) }
    let r = try Rig(.tmux, scenario: "dev-dialog.sh", loginExtra: ["TMPDIR": long + "/"])
    defer { r.teardown() }
    r.start()
    var path = ""
    #expect(r.wait(10) {
      let out = ProcessRunner.run(
        [Rig.tmuxPath!, "-L", r.socket, "display-message", "-p", "#{socket_path}"], env: r.loginEnv)
      path = out.out.trimmingCharacters(in: .whitespacesAndNewlines)
      return out.ok && !path.isEmpty
    }, "the rig's tmux server is up")
    #expect(path.utf8.count <= Self.maxSocketPath, "socket path is \(path.utf8.count) bytes: \(path)")
    #expect(path.hasSuffix("/" + r.socket))
    #expect(!path.hasPrefix(r.root) && !path.hasPrefix(long), "socket made inside the temp folder: \(path)")
    #expect(Rig.realPath(Rig.tmuxSocketPath(r.socket)) == path)
  }
}
