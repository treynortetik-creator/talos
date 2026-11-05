import Foundation

/// The line under the Quick Compose box and whether Send is on, from what the panel knows. One function decides both, so Send is
/// never off without a reason on screen, and a reason never outlives its cause.
public enum ComposeStatus {
  public static let lostLine = "Talos went away before answering. Check the thread before sending again."
  public static let notTakenLine = "Talos didn't take that (is it open and signed in?). Your text is kept."
  /// The same, over a box with no text: there is nothing to say is kept.
  public static let notTakenEmptyLine = "Talos didn't take that (is it open and signed in?)."
  public static let emptyLine = "Write something first."
  public static let tooLongLine = "That is too long to send (32,000 characters at most)."
  public static let pickLine = "Pick a thread."
  public static let goneLine = "That thread is gone. Your text is kept. Pick a thread to send it."
  public static let noThreadsLine = "No threads yet. Open Talos once so it can list them."
  public static let sendingLine = "Sending…"

  public struct Inputs: Equatable, Sendable {
    public var signedIn = true
    public var hasThreads = true
    /// The draft's thread left the list.
    public var threadGone = false
    /// A message is out and the page has not answered.
    public var sending = false
    public var text = "hello"
    /// The "went away" warning is up and there is text it is about.
    public var lost = false
    /// The page did not take the last Send and the text it is about is still in the box.
    public var notTaken = false
    /// The label of the thread the draft belongs to, when an entry point asked for another.
    public var keepingDraftFor: String?
    public init() {}
  }

  public struct Result: Equatable, Sendable {
    public var line: String
    public var sendEnabled: Bool
    /// The line is information, not a problem.
    public var info: Bool
  }

  /// What the last action said (a refused Send, a Send that left newer text behind) and whether it is information.
  public struct Event: Equatable, Sendable {
    public var line: String
    public var isInfo: Bool
    public init(line: String, isInfo: Bool) {
      self.line = line
      self.isInfo = isInfo
    }
  }

  /// Which of the last action's lines a refresh keeps: all of them, unless the refresh found a reason that outranks them (signed
  /// out, no threads, the draft's thread gone). Those replace the line for good, so it cannot come back when the reason ends.
  public static func eventKeptThroughRefresh(_ event: Event?, _ i: Inputs) -> Event? {
    i.signedIn && i.hasThreads && !i.threadGone ? event : nil
  }

  /// `event` is what the last action said (a refused Send). It is shown in front of the reason Send is off, if there is one, after it
  /// comes the "page did not take it" line, and the "went away" warning always comes last. Both of those are inputs, so they stay
  /// through a refresh, signed out too. Over a box with no text the "page did not take it" line is still said, without "Your text is
  /// kept." (there is none), so the owner is always told it did not go.
  public static func evaluate(_ i: Inputs, event: String? = nil, eventIsInfo: Bool = false) -> Result {
    let trimmed = i.text.trimmingCharacters(in: .whitespacesAndNewlines)
    let notTaken: String? = i.notTaken ? (trimmed.isEmpty ? notTakenEmptyLine : notTakenLine) : nil
    // Signed out the panel shows the sign-in view, but what the last Send left behind is kept for when the owner is back.
    guard i.signedIn else {
      let kept = [notTaken, i.lost ? lostLine : nil].compactMap { $0 }
      return Result(line: kept.joined(separator: "\n"), sendEnabled: false, info: false)
    }
    var reason: String?
    var reasonIsInfo = false
    var enabled = false
    if i.threadGone {
      reason = goneLine
    } else if i.sending {
      return Result(line: sendingLine, sendEnabled: false, info: true)  // a message is out: the line is about that alone
    } else if !i.hasThreads {
      reason = noThreadsLine
    } else if !i.text.isEmpty && trimmed.isEmpty {
      reason = emptyLine  // an empty box stays quiet: the box is the prompt, and a Send there says what is missing
    } else if trimmed.utf16.count > ComposeRules.maxLength {
      reason = tooLongLine
    } else {
      enabled = true
      if let k = i.keepingDraftFor {
        reason = "Keeping your draft for \(k)."
        reasonIsInfo = true
      }
    }
    var lines: [String] = []
    for l in [event, notTaken, reason, i.lost ? lostLine : nil] {
      if let l, !lines.contains(l) { lines.append(l) }
    }
    let info = !i.lost && notTaken == nil && !lines.isEmpty && (event == nil || eventIsInfo) && (reason == nil || reasonIsInfo)
    return Result(line: lines.joined(separator: "\n"), sendEnabled: enabled, info: info)
  }
}
