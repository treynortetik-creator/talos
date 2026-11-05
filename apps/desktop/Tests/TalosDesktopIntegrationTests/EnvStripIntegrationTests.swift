import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// The agent the app starts must not inherit another Claude session's markers (2026-11-03: CLAUDE_CODE_CHILD_SESSION
/// turned transcript saving off). Real pty / real private tmux, with a fake claude that dumps the env it received.
private let markers: [String: String] = [
  "CLAUDE_CODE_CHILD_SESSION": "1", "CLAUDE_CODE_SESSION_ID": "0f1e2d3c-4b5a-4968-8776-655443322110",
  "CLAUDE_CODE_SESSION_ATTENDED": "1", "CLAUDE_CODE_BRIDGE_SESSION_ID": "bridge_x",
  "CLAUDE_CODE_MESSAGING_SOCKET": "/tmp/s.sock", "CLAUDE_CODE_MESSAGING_TOKEN": "tok",
  "CLAUDE_CODE_EXECPATH": "/home/alex/.local/bin/claude", "CLAUDECODE": "1", "CLAUDE_PID": "123",
]

private func dump(_ r: Rig, _ n: Int) -> [String: String]? {
  guard let s = try? String(contentsOfFile: r.agentDir + "-envdump.\(n)", encoding: .utf8) else { return nil }
  var out: [String: String] = [:]
  for l in s.split(separator: "\n") {
    guard let eq = l.firstIndex(of: "=") else { continue }
    out[String(l[..<eq])] = String(l[l.index(after: eq)...])
  }
  // An empty or partial file is "not written yet", not an empty environment (a real claude always has PATH and HOME).
  guard out["PATH"] != nil, out["HOME"] != nil else { return nil }
  return out
}

private func expectClean(_ e: [String: String], _ why: String) {
  for k in markers.keys { #expect(e[k] == nil, "\(k) reached the agent (\(why))") }
  #expect(e["PATH"] != nil, "PATH kept (\(why))")
  #expect(e["HOME"] != nil, "HOME kept (\(why))")
  #expect(e["CLAUDE_CODE_AUTO_COMPACT_WINDOW"] == "400000", "keep-list value survives (\(why))")
}

@Suite("Env strip (real pty, real tmux)", .serialized)
struct EnvStripIntegrationTests {
  private func rig(_ kind: HostKind) throws -> Rig {
    try Rig(
      kind, scenario: "dev-dialog.sh",
      loginExtra: markers.merging(["CLAUDE_CODE_AUTO_COMPACT_WINDOW": "400000"]) { a, _ in a }
    ) { c in c.env["FAKE_ENV_DUMP"] = c.agentDir + "-envdump" }
  }

  /// Launch path: Supervisor cold start (Start in the app, adopt's cold start, relaunch).
  @Test(arguments: bothHosts)
  func aColdStartFromAPollutedLoginEnvIsClean(kind: HostKind) throws {
    let r = try rig(kind)
    defer { r.teardown() }
    r.start()
    #expect(r.wait(10) { dump(r, 1) != nil }, "claude started")
    expectClean(try #require(dump(r, 1)), "cold start")
  }

  /// Launch path: Supervisor restart (Restart session / crash respawn: tmux respawn-pane).
  @Test(arguments: bothHosts)
  func aRestartIsCleanToo(kind: HostKind) throws {
    let r = try rig(kind)
    defer { r.teardown() }
    try coldStartConfirmed(r)
    #expect(r.wait(10) { dump(r, 1) != nil })
    r.sup.restartCold()
    #expect(r.wait(20) { r.sup.tickNow(); return dump(r, 2) != nil }, "second start: \(r.phase()) \(r.audit)")
    expectClean(try #require(dump(r, 2)), "restart")
  }

  /// A tmux server that a polluted process started carries the markers in its own global env; `-e` cannot remove them.
  @Test(.enabled(if: Rig.hasTmux))
  func aTmuxServerStartedByAPollutedProcessDoesNotHandThemOn() throws {
    let r = try rig(.tmux)
    defer { r.teardown() }
    let polluted = r.loginEnv.merging(markers) { _, b in b }
    let made = ProcessRunner.run(
      [Rig.tmuxPath!, "-L", r.socket, "-f", Rig.tmuxConf, "new-session", "-d", "-s", "other", "--", "/bin/sleep", "300"],
      env: polluted)
    #expect(made.ok, "polluted server: \(made.err)")
    let seen = ProcessRunner.run([Rig.tmuxPath!, "-L", r.socket, "-f", Rig.tmuxConf, "show-environment", "-g"], env: r.loginEnv)
    #expect(seen.out.contains("CLAUDE_CODE_CHILD_SESSION"), "precondition: the server holds the marker: \(seen.out)")
    r.start()
    #expect(r.wait(10) { dump(r, 1) != nil }, "claude started")
    expectClean(try #require(dump(r, 1)), "polluted server")
  }

  /// An older build created the session with the markers set on the SESSION (`new-session -e`), not on the server. A
  /// restart must respawn the pane without them: the session-level scrub, not the global one.
  @Test(.enabled(if: Rig.hasTmux))
  func aRestartRemovesMarkersTheOldBuildSetOnTheSession() throws {
    let r = try rig(.tmux)
    defer { r.teardown() }
    let out = r.root + "/respawn-env"
    let clean = ClaudeEnvScrub.scrub(r.loginEnv)  // the server itself starts clean; only the session carries markers
    let flags = markers.sorted { $0.key < $1.key }.flatMap { ["-e", "\($0.key)=\($0.value)"] }
    // A server that already runs (the first session's -e would land in the server's global env instead).
    let first = ProcessRunner.run(
      [Rig.tmuxPath!, "-L", r.socket, "-f", Rig.tmuxConf, "new-session", "-d", "-s", "other", "--", "/bin/sleep", "300"],
      env: clean)
    #expect(first.ok, "server: \(first.err)")
    let made = ProcessRunner.run(
      [Rig.tmuxPath!, "-L", r.socket, "-f", Rig.tmuxConf, "new-session", "-d", "-s", "agent"] + flags + ["--", "/bin/sleep", "300"],
      env: clean)
    #expect(made.ok, "old-build session: \(made.err)")
    let sess = ProcessRunner.run([Rig.tmuxPath!, "-L", r.socket, "-f", Rig.tmuxConf, "show-environment", "-t", "agent"], env: clean)
    #expect(sess.out.contains("CLAUDE_CODE_CHILD_SESSION=1"), "precondition: the session holds the marker: \(sess.out)")
    let glob = ProcessRunner.run([Rig.tmuxPath!, "-L", r.socket, "-f", Rig.tmuxConf, "show-environment", "-g"], env: clean)
    #expect(!glob.out.contains("CLAUDE_CODE_CHILD_SESSION"), "precondition: only the session holds it: \(glob.out)")
    let host = try #require(r.host as? TmuxPtyHost)
    try host.restart(
      executable: "/bin/sh", args: ["-c", "/usr/bin/env > '\(out).tmp' && mv '\(out).tmp' '\(out)'; exec /bin/sleep 300"],
      env: clean.merging(["CLAUDE_CODE_AUTO_COMPACT_WINDOW": "400000"]) { a, _ in a }, cwd: r.agentDir)
    #expect(r.wait(10) { FileManager.default.fileExists(atPath: out) }, "respawned pane ran")
    let got = (try? String(contentsOfFile: out, encoding: .utf8)) ?? ""
    for k in markers.keys { #expect(!got.contains("\n\(k)=") && !got.hasPrefix("\(k)="), "\(k) survived the restart") }
    #expect(got.contains("HOME="))
    #expect(got.contains("CLAUDE_CODE_AUTO_COMPACT_WINDOW=400000"))
  }
}
