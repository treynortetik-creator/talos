import Foundation

/// The owner's one line about a round of restarts on update, word for word the protocol's `updateRestartLine`
/// (packages/protocol/src/wake-decision.ts; both are checked against apps/desktop/Tests/Fixtures/update-restart-line.json, by
/// swift-parity.test.ts and UpdateRestartLineTests). nil when there is nothing to say.
public enum UpdateRestartLine {
  /// `notRestarted`: given up, stopped for the restart and never started again (the protocol's optional fourth group).
  public static func line(restarted: [String], waiting: [String], failed: [String], notRestarted: [String] = []) -> String? {
    func list(_ names: [String]) -> String { names.map(oneLine).joined(separator: ", ") }
    var parts: [String] = []
    if !restarted.isEmpty { parts.append("restarted \(list(restarted))") }
    if !waiting.isEmpty {
      parts.append("\(list(waiting)) \(waiting.count == 1 ? "restarts when its turn ends" : "restart when their turns end")")
    }
    if !failed.isEmpty { parts.append("\(list(failed)) failed") }
    if !notRestarted.isEmpty {
      parts.append(
        notRestarted.count == 1
          ? "\(list(notRestarted)) was not restarted (it did not start again)"
          : "\(list(notRestarted)) were not restarted (they did not start again)")
    }
    return parts.isEmpty ? nil : "Updated or instructions changed: \(parts.joined(separator: "; "))."
  }

  /// A name on one line: each run of CR, LF, U+2028 and U+2029 is one space (the protocol's `oneLine`).
  static func oneLine(_ s: String) -> String {
    var out = ""
    var inRun = false
    for u in s.unicodeScalars {
      if [0x0D, 0x0A, 0x2028, 0x2029].contains(u.value) {
        if !inRun { out += " " }
        inRun = true
      } else {
        out.unicodeScalars.append(u)
        inRun = false
      }
    }
    return out
  }
}
