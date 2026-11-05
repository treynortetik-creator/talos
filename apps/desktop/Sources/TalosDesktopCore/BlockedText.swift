import Foundation

/// What the Blocked screen says, once. A start can be blocked by several things held by one other session (Telegram, the
/// bridge, the channels), and the notice repeats the first of them; the screen used to print the same warning three times
/// (first real Mac run, 2026-11-01).
public enum BlockedText {
  /// The button that starts Adopt, worded exactly as the screen shows it.
  public static let adoptButton = "Find a running session"

  /// Settings' line while nothing is set up yet; it names the button by its own constant.
  public static let notSetUpLine =
    "Not set up yet. Import your command or press \u{201C}\(adoptButton)\u{201D} to create your setup. Nothing starts before then, and changes you make here are kept until you do."

  /// The one-shot button on the Blocked screen, and what it risks.
  public static let startAnywayButton = "Start anyway"
  public static let startAnywayWarning =
    "Starting anyway runs a second session beside it. Both may answer the same messages, and the Talos bridge can end up on the wrong one."

  /// Whether the Blocked screen offers "Start anyway": only when something blocks, and never when Telegram is a holder (that
  /// ban stands: two pollers on one bot is what breaks the live chat).
  public static func offersStartAnyway(_ blockers: [TakeoverCheck.Blocker]) -> Bool {
    !blockers.isEmpty && !blockers.contains { $0.resource == .telegram }
  }

  /// One line per other session, naming everything it holds.
  public static func lines(_ blockers: [TakeoverCheck.Blocker]) -> [String] {
    var order: [Int32] = []
    var held: [Int32: [String]] = [:]
    var folder: [Int32: String] = [:]
    for b in blockers {
      if held[b.sessionPid] == nil { order.append(b.sessionPid) }
      var list = held[b.sessionPid] ?? []
      if !list.contains(b.resource.rawValue) { list.append(b.resource.rawValue) }
      held[b.sessionPid] = list
      if let f = b.folder, folder[b.sessionPid] == nil { folder[b.sessionPid] = f }
    }
    return order.map { pid in
      let f = folder[pid].map { ", folder \($0)" } ?? ""
      return "Another Claude session (pid \(pid)\(f)) holds \(join(held[pid] ?? [])). Quit it first, or press \u{201C}\(adoptButton)\u{201D} to take it over."
    }
  }

  /// The notice line under the status. While the Blocked screen itself lists the holders, the notice that repeats them is
  /// dropped; any other notice stays.
  public static func notice(_ text: String, whileBlocked blocked: Bool) -> String {
    blocked && text.hasPrefix(SupervisorNotice.blocked) ? "" : text
  }

  static func join(_ items: [String]) -> String {
    switch items.count {
    case 0: return "the channels"
    case 1: return items[0]
    case 2: return items[0] + " and " + items[1]
    default: return items.dropLast().joined(separator: ", ") + " and " + items[items.count - 1]
    }
  }
}
