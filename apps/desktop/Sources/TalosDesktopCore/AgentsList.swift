import Foundation

/// `claude agents --json` (2.1.312: a JSON array; read from the binary's `printAgentsJson`). Interactive entries carry
/// `pid`, `sessionId`, `status`, `cwd`; background entries may lack `pid` and carry `state` instead of `status`
/// (review finding 22). Unknown fields and odd entries are skipped, never fatal.
public struct AgentEntry: Equatable, Sendable {
  public var kind: String
  public var pid: Int32?
  public var sessionId: String?
  public var status: String?
  public var state: String?
  public var cwd: String?

  public init(kind: String, pid: Int32?, sessionId: String?, status: String?, state: String? = nil, cwd: String?) {
    self.kind = kind
    self.pid = pid
    self.sessionId = sessionId
    self.status = status
    self.state = state
    self.cwd = cwd
  }

  public var isInteractive: Bool { kind == "interactive" }
}

public enum AgentsList {
  public static let argv = ["agents", "--json"]

  /// nil when the output isn't a JSON array (or an object holding one): "couldn't read", not "no sessions".
  public static func decode(_ data: Data) -> [AgentEntry]? {
    guard let any = try? JSONSerialization.jsonObject(with: data) else { return nil }
    let items: [Any]
    if let a = any as? [Any] {
      items = a
    } else if let o = any as? [String: Any], let a = (o["agents"] ?? o["sessions"]) as? [Any] {
      items = a
    } else {
      return nil
    }
    return items.compactMap { item in
      guard let o = item as? [String: Any] else { return nil }
      let kind = (o["kind"] as? String) ?? "unknown"
      var pid: Int32?
      if let n = o["pid"] as? NSNumber, n.int64Value > 0, n.int64Value < Int64(Int32.max) { pid = Int32(n.int64Value) }
      return AgentEntry(
        kind: kind, pid: pid, sessionId: (o["sessionId"] as? String)?.lowercased(), status: o["status"] as? String,
        state: o["state"] as? String, cwd: o["cwd"] as? String)
    }
  }

  public static func interactive(_ entries: [AgentEntry], pid: Int32) -> AgentEntry? {
    entries.first { $0.isInteractive && $0.pid == pid }
  }
}
