import CryptoKit
import Foundation
import TalosDesktopCore

/// The phone the rigs' owner requests are signed by: one key for the test run, pinned in a rig's devices.json when it writes one.
let rigPhone = TestOwner()

extension Rig {
  var devicesFile: String { talosHome + "/devices.json" }

  /// devices.json as the bridge writes it, with `rigPhone` paired (or the entries given).
  func pinPhone(_ entries: [[String: Any]]? = nil) throws {
    try JSONSerialization.data(withJSONObject: ["version": 1, "devices": entries ?? [rigPhone.entry()]])
      .write(to: URL(fileURLWithPath: devicesFile), options: .atomic)
  }

  /// The proof the bridge copies from the phone's signed `agent.recover` (frames.ts `AgentRequestProof`): `edit` changes what is signed
  /// before it is signed, so the signature is always a real one over what it covers.
  func ownerProof(
    _ controlId: String, by owner: TestOwner = rigPhone, frameAgeMs: Double = 0, _ edit: (inout [String: Any]) -> Void = { _ in }
  ) -> [String: Any] {
    var frame: [String: Any] = [
      "v": 1, "type": "agent.recover", "id": "01KA0000000000000000000\(String(format: "%03d", Int.random(in: 0..<1000)))",
      "ts": ISOTime.string((clock.wallMs() - frameAgeMs) / 1000), "control_id": controlId, "action": "restart", "device_id": owner.deviceId,
    ]
    edit(&frame)
    let signed = TestOwner.json(frame)
    let b64 = Data(signed.utf8).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
    return ["device_id": owner.deviceId, "osig": owner.osig(signed), "signed_b64url": b64]
  }

  /// The request file. `proof`: the owner's (`ownerProof`), or none (a session's `restart_main`, or an older bridge). `extra` is more raw
  /// JSON fields (`,"by_thread":"trip"`, an old `,"asked_by":"owner"`).
  func writeAgentRequest(_ id: String, ageMs: Double = 0, proof: [String: Any]? = nil, extra: String = "") throws {
    var o: [String: Any] = ["v": 1, "control_id": id, "action": "restart", "ts": Int(clock.wallMs() - ageMs)]
    if let proof { o["proof"] = proof }
    var text = TestOwner.json(o)
    if !extra.isEmpty { text = String(text.dropLast()) + extra + "}" }
    try text.write(toFile: talosHome + "/" + AgentRequest.fileName, atomically: true, encoding: .utf8)
  }

  /// The phone's own Restart agent through a current bridge: `rigPhone` pinned, the proof in the file.
  func writeOwnerRequest(_ id: String, ageMs: Double = 0) throws {
    if !FileManager.default.fileExists(atPath: devicesFile) { try pinPhone() }
    try writeAgentRequest(id, ageMs: ageMs, proof: ownerProof(id))
  }
}
