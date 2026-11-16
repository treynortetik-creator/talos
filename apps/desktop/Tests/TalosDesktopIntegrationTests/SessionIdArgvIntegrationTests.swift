import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor
import TalosTestSupport

/// desktop.json's `session.id` is outside the launch seal and may be written by an agent: the real start must never pass it as a flag.
/// Real pty, the fake claude, which dumps its argv one element per line (`FAKE_ARGV_DUMP`).
@Suite("Main's session id in the real start", .serialized)
struct SessionIdArgvIntegrationTests {
  private func rig(_ id: String) throws -> (Rig, String) {
    let dump = TestTemp.base + "/argv-\(UUID().uuidString.prefix(8))"
    let r = try Rig(.direct, scenario: "dev-dialog.sh", env: ["FAKE_ARGV_DUMP": dump], session: DesktopConfig.Session(id: id))
    return (r, dump)
  }

  private func argv(_ dump: String, _ n: Int = 1) -> [String] {
    ((try? String(contentsOfFile: "\(dump).\(n)", encoding: .utf8)) ?? "").split(separator: "\n").map { String($0.dropFirst().dropLast()) }
  }

  @Test(arguments: ["--some-flag", "--settings=/x", "11111111-2222-4333-8444-555555555555 --dangerously-skip-permissions"])
  func aSavedIdThatIsNotAUUIDStartsNothingAndSaysWhy(_ id: String) throws {
    let (r, dump) = try rig(id)
    defer {
      r.teardown()
      try? FileManager.default.removeItem(atPath: dump + ".1")
    }
    r.start()
    #expect(r.wait(10) { r.sup.tickNow(); if case .stopped(.startFailed) = r.phase() { return true } else { return false } }, "\(r.phase()), audit: \(r.audit)")
    usleep(300_000)
    #expect(r.starts.isEmpty, "claude was started: \(r.starts)")
    #expect(argv(dump).isEmpty)
    #expect(r.phase() == .stopped(.startFailed(SupervisorNotice.sessionIdInvalid)))
    #expect(r.audit.contains("session_id_invalid"), "audit: \(r.audit)")
    #expect(!r.audit.contains(id), "the value itself is never logged")
    #expect(r.config.session.id == id, "nothing is changed behind the owner's back: no fresh conversation under the old one")
  }

  /// The rollback command the menu copies for Terminal carries the same id: it is left out there too.
  @Test func theTerminalCommandLeavesAnIdThatIsNotAUUIDOut() throws {
    let (r, dump) = try rig("--settings=/x")
    defer { r.teardown(); _ = dump }
    let cmd = r.sup.terminalCommand()
    #expect(!cmd.contains("--settings=/x") && !cmd.contains("--resume"), "\(cmd)")
    let (ok, dump2) = try rig(Rig.sessionId)
    defer { ok.teardown(); _ = dump2 }
    #expect(ok.sup.terminalCommand().hasSuffix("--resume \(Rig.sessionId)"), "\(ok.sup.terminalCommand())")
  }

  /// The owner's way out is the existing one: Start a new conversation retires the id and starts with a new UUID.
  @Test func startANewConversationGetsPastIt() throws {
    let (r, dump) = try rig("--some-flag")
    defer {
      r.teardown()
      for n in 1...2 { try? FileManager.default.removeItem(atPath: "\(dump).\(n)") }
    }
    r.start()
    #expect(r.wait(10) { r.sup.tickNow(); if case .stopped(.startFailed) = r.phase() { return true } else { return false } })
    r.sup.startNewConversation()
    #expect(r.wait(20) { r.sup.tickNow(); return isRunning(r.phase()) }, "\(r.phase()), audit: \(r.audit)")
    let a = argv(dump)
    let newId = try #require(r.config.session.id)
    #expect(ResumeRewrite.isUUID(newId))
    #expect(a.last == "--session-id=\(newId)", "\(a)")
    #expect(!a.contains("--some-flag"))
  }

  /// A real id goes in as one argument, and a restart resumes it the same way.
  @Test func aUUIDIsPassedAsOneArgument() throws {
    let (r, dump) = try rig(Rig.sessionId)
    defer {
      r.teardown()
      for n in 1...2 { try? FileManager.default.removeItem(atPath: "\(dump).\(n)") }
    }
    r.start()
    #expect(r.wait(20) { r.sup.tickNow(); return isRunning(r.phase()) }, "\(r.phase()), audit: \(r.audit)")
    #expect(argv(dump).last == "--resume=\(Rig.sessionId)", "\(argv(dump))")
    #expect(!argv(dump).contains("--resume"))
    r.sup.restartCold()
    #expect(r.wait(30) { r.sup.tickNow(); return r.starts.count == 2 && isRunning(r.phase()) }, "audit: \(r.audit)")
    #expect(argv(dump, 2).last == "--resume=\(Rig.sessionId)", "\(argv(dump, 2))")
    #expect(r.autoConfirms == 2, "the sealed launch is still answered: the fingerprint did not move")
  }
}
