import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// PR #68, third review. The owned pty's direct write (`SwiftTermPtyHost.send`). Every child here ends on its own and is
/// started by the test; nothing else is touched. Run: bash apps/desktop/scripts/test.sh --filter ReviewOC3R3
private final class Flag: @unchecked Sendable {
  private let lock = NSLock()
  private var _value = false
  var value: Bool {
    get { lock.withLock { _value } }
    set { lock.withLock { _value = newValue } }
  }
}

@Suite("Review OC3 R3 owned pty", .serialized)
struct ReviewOC3R3Pty {
  private func outPath(_ name: String) -> String {
    NSTemporaryDirectory() + "rv-oc3-r3-\(getpid())-\(UUID().uuidString.prefix(8))-\(name)"
  }

  private func start(_ script: String, arg: String) throws -> SwiftTermPtyHost {
    let h = SwiftTermPtyHost()
    try h.start(executable: "/bin/sh", args: ["-c", script, "sh", arg], env: ["PATH": "/usr/bin:/bin"], cwd: "/tmp")
    return h
  }

  private func bytes(_ path: String) -> Data { FileManager.default.contents(atPath: path) ?? Data() }

  /// The stall the PR calls unexplained, forced on purpose. DispatchIO runs at default QoS, and once every cooperative thread
  /// is blocked (OBSERVED: exactly `activeProcessorCount` of them, one fewer is fine) default QoS gets no thread. The test
  /// suite does this by blocking in `usleep` inside `@Test`s. `LocalProcess.send` here takes as long as the block; put that
  /// line back in `send(keys:)` and this test goes red.
  /// It starves the process-wide pool, which would sabotage every suite running beside it, so it is off in the normal run and
  /// runs alone: `bash scripts/starvation-tests.sh` (CI's `scripts/ci.sh` runs it after the main run).
  @Test(.enabled(if: ProcessInfo.processInfo.environment["TALOS_STARVATION_TESTS"] == "1"))
  func anEnterGetsThroughWhileTheDispatchPoolIsStarved() async throws {
    let out = outPath("starved")
    defer { unlink(out) }
    let h = try start(#"stty raw -echo; exec 3<&0; cat <&3 > "$1" & c=$!; sleep 5; kill $c"#, arg: out)
    usleep(400_000)
    let arrived = Flag()
    let probe = Thread {
      usleep(500_000)  // the block below has taken every cooperative thread by now
      h.send(keys: [0x0d])
      let until = Date().addingTimeInterval(1)
      while Date() < until, !arrived.value {
        if !FileManager.default.fileExists(atPath: out) { break }
        arrived.value = (FileManager.default.contents(atPath: out)?.count ?? 0) >= 1
        usleep(20_000)
      }
    }
    probe.start()
    await withTaskGroup(of: Void.self) { g in
      for _ in 0..<ProcessInfo.processInfo.activeProcessorCount { g.addTask { usleep(2_000_000) } }
    }
    #expect(arrived.value, "the Enter waited for the dispatch pool")
  }

  /// The other writer on this pty is the terminal's own replies, through DispatchIO on a dup of the same descriptor. Each
  /// reply is one write(2), so with a child that keeps up an Enter lands between replies, never inside one. That holds only
  /// while the input queue has room: at a full queue (about 1 KB unread) DispatchIO's write goes through in parts and an
  /// Enter can land between them (OBSERVED: 5 to 13 of 1,500 replies with a deliberately slow reader). Nothing here gets
  /// near that: the only `send(keys:)` caller is one Enter at a dialog, and replies are a few bytes the CLI reads at once.
  @Test func anEnterNeverLandsInsideATerminalReply() throws {
    let out = outPath("replies")
    defer { unlink(out) }
    let script = #"""
      stty raw -echo; exec 3<&0; cat <&3 > "$1" & c=$!
      i=0; while [ $i -lt 60 ]; do printf '\033[6n'; /bin/sleep 0.01; i=$((i+1)); done
      sleep 1; kill $c
      """#
    let h = try start(script, arg: out)
    for _ in 0..<1000 {
      h.send(keys: [0x0d])
      usleep(800)
    }
    usleep(1_500_000)
    var text = String(decoding: bytes(out), as: UTF8.self)
    let replies = text.ranges(of: /\x1b\[\d+;\d+R/).count
    text.replace(/\x1b\[\d+;\d+R/, with: "")
    #expect(replies > 0, "no reply reached the child: this test proved nothing")
    // what's left is Enters only (an Enter sent before `stty raw` ran reads as a newline): any byte of a split reply stays
    let rest = text.unicodeScalars.filter { $0 != "\r" && $0 != "\n" }
    #expect(rest.isEmpty, "a reply was split: \(String(String.UnicodeScalarView(rest)).debugDescription.prefix(120))")
  }

  /// O_NONBLOCK is on the pty (SwiftTerm's reader sets it on the shared file description), so a child that has stopped
  /// reading costs the caller nothing: after about 1 KB the rest is dropped, and `send` returns.
  @Test func aFullInputQueueNeverBlocksTheCaller() throws {
    let h = try start("stty raw -echo; sleep 3", arg: "")
    usleep(300_000)
    let returned = Flag()
    let t = Thread {
      h.send(keys: [UInt8](repeating: 0x61, count: 8192))
      returned.value = true
    }
    t.start()
    let until = Date().addingTimeInterval(1)
    while Date() < until, !returned.value { usleep(10_000) }
    #expect(returned.value, "send blocked on a full pty")
  }

  @Test func aSendAfterTheChildHasGoneIsHarmless() throws {
    let h = try start("exit 0", arg: "")
    usleep(400_000)
    h.send(keys: [0x0d])
    h.send(keys: [UInt8](repeating: 0x61, count: 4096))
  }
}
