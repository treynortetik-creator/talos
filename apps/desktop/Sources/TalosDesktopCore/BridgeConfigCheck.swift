import Foundation

/// Why Main's bridge would not start, when the cause is its own `config.json` in the Talos home: the bridge refuses to start on a
/// file it cannot parse, and Claude Code's MCP log often says only that the connection closed. Only what can be told without the
/// bridge: the file is there and is not a JSON object. A missing file, or one that parses but fails the bridge's own checks, is
/// left to the log.
public enum BridgeConfigCheck {
  public static func problem(_ data: Data?, path: String) -> String? {
    guard let data, !((try? JSONSerialization.jsonObject(with: data)) is [String: Any]) else { return nil }
    return "its config.json is damaged (not valid JSON: \(path)); fix the file or restore it"
  }
}
