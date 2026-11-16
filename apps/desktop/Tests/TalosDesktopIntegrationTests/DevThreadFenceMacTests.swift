import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// The developer thread fence through the real start (WorkerManager on a private tmux server, the fake claude, a fake HOME and Talos
/// home): config.json is read again at each start, `"dev": {"thread_fence": false}` exactly leaves the Talos-home deny out of the
/// settings written for the session and puts `worker_thread_fence_off thread=<id>` in the audit log; any other value keeps the fence.
@Suite("Developer thread fence: launch", .serialized, .enabled(if: Rig.hasTmux))
struct DevThreadFenceLaunchTests {
  func config(_ r: WorkerRig, dev: String?) throws {
    let devPart = dev.map { #","dev":\#($0)"# } ?? ""
    try """
    {"default_thread":"general","dedicated":{"enabled":true,"max_live":3},"threads":[{"id":"general","kind":"fixed"},{"id":"trip","name":"Trip","kind":"fixed","session":"dedicated","session_opts":{}}]\(devPart)}
    """.write(toFile: r.talosHome + "/config.json", atomically: true, encoding: .utf8)
  }

  /// Starts `trip` under `dev` and gives back its deny rules on disk and the audit log's lines.
  func launch(dev: String?) throws -> (deny: [String], audit: [String], talosHome: String) {
    let r = try WorkerRig(scenario: "review-worker.sh")
    defer { r.teardown() }
    try r.fenceWorld()
    try config(r, dev: dev)
    let audit = r.root + "/audit.log"
    r.manager(busyWindow: 0.5)
    r.mgr.tune { $0.auditLogPath = audit }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    #expect(r.entry("trip")?.error == nil)
    let deny = ((r.settingsOnDisk["permissions"] as? [String: Any])?["deny"] as? [String]) ?? []
    return (deny, r.lines(audit), r.talosHome)
  }

  @Test func exactlyFalseStartsWithNoTalosHomeDenyAndSaysSo() throws {
    let (deny, audit, home) = try launch(dev: #"{"thread_fence":false}"#)
    for rule in WorkerFence.denyRules(talosHome: home) { #expect(!deny.contains(rule), "\(rule)") }
    for rule in WorkerFence.extraDeny + WorkerFence.deniedTools + WorkerFence.workerFilesDeny(talosHome: home) {
      #expect(deny.contains(rule), "\(rule)")
    }
    #expect(audit.filter { $0.hasSuffix("worker_thread_fence_off thread=trip") }.count == 1, "\(audit)")
  }

  @Test func anythingElseKeepsTheFenceAndSaysNothing() throws {
    for dev in [nil, #"{"thread_fence":true}"#, #"{"thread_fence":"false"}"#, #"{"thread_fence":0}"#, #"false"#] {
      let (deny, audit, home) = try launch(dev: dev)
      for rule in WorkerFence.denyRules(talosHome: home) { #expect(deny.contains(rule), "\(dev ?? "absent"): \(rule)") }
      #expect(!audit.contains { $0.contains("worker_thread_fence_off") }, "\(dev ?? "absent"): \(audit)")
    }
  }
}
