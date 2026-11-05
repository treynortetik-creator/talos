import Foundation

/// What the companion may say (spec 3.4, 2.5). A bubble is a closed enum plus one sanitized label: no code path takes a free
/// string, and no message text can reach it. Phrases that exist in the push builder reuse its wording, so a test can hold them
/// to `NotificationPolicy.isPushPhrase`.
public enum CompanionBubble: Equatable, Sendable {
  case sessionStopped(agent: String)
  case needsYou(agent: String)
  case overnight(items: Int)
  /// C-LIVE: thread names in bubbles. `thread` is the page's name for it, sanitized here; `id` is what a click opens.
  case needsYouIn(thread: String, id: String)
  case newReply(thread: String, id: String)
  case sendFailed

  /// The thread a click on this bubble opens, if it names one.
  public var threadId: String? {
    switch self {
    case .needsYouIn(_, let id), .newReply(_, let id): return id
    default: return nil
    }
  }

  public var text: String {
    switch self {
    case .needsYouIn(let t, _): return "Needs you in \(CompanionPhrase.label(t))"
    case .newReply(let t, _): return "New reply in \(CompanionPhrase.label(t))"
    case .sendFailed: return "A message didn't send"
    case .sessionStopped(let a): return "\(CompanionPhrase.label(a))'s Mac session stopped"
    case .needsYou(let a): return "\(CompanionPhrase.label(a)) needs you"
    case .overnight(let n): return "Overnight: \(max(0, min(n, 99_999))) items"
    }
  }
}

public enum CompanionPhrase {
  /// A label for a bubble, tooltip or VoiceOver line: plain, one line, at most 40 characters. Control, format (bidi marks,
  /// zero width), line and paragraph separators go; runs of spaces collapse. Empty becomes "Talos".
  public static func label(_ s: String) -> String {
    var out = String.UnicodeScalarView()
    var lastSpace = false
    for u in s.unicodeScalars {
      switch u.properties.generalCategory {
      case .control, .format, .lineSeparator, .paragraphSeparator, .surrogate, .privateUse, .unassigned:
        if u == "\n" || u == "\r" || u == "\t" {  // a line break between words reads as a space
          if !lastSpace { out.append(" ") }
          lastSpace = true
        }
        continue
      case .spaceSeparator:
        if !lastSpace { out.append(" ") }
        lastSpace = true
      default:
        out.append(u)
        lastSpace = false
      }
    }
    let t = String(String(out).prefix(40)).trimmingCharacters(in: .whitespaces)
    return t.isEmpty ? "Talos" : t
  }

  /// The reply card's text: what the page sent, with control, format (bidi marks, zero width) and separator characters taken
  /// out (a newline stays), at most 500 characters. The page already did this; the Mac does not trust it.
  public static func replyText(_ s: String) -> String {
    var out = String.UnicodeScalarView()
    for u in s.unicodeScalars {
      switch u.properties.generalCategory {
      case .control, .format, .lineSeparator, .paragraphSeparator, .surrogate, .privateUse, .unassigned:
        if u == "\n" || u == "\r" || u == "\t" { out.append(u == "\t" ? " " : "\n") }
      default:
        out.append(u)
      }
    }
    return String(String(out).prefix(CompanionReply.maxText)).trimmingCharacters(in: .whitespacesAndNewlines)
  }

  /// The word line under the hover controls and the tooltip. `count` is the Needs-you count.
  public static func word(_ s: CompanionState, session: CompanionSession, relayDown: Bool, needs: Int, count: Int = 0) -> String {
    switch s {
    case .down:
      if case .stopped(let byOwner) = session, !byOwner { return "Session stopped" }
      return relayDown ? "Can't reach the relay" : "Session stopped"
    case .needsYou: return needs > 0 ? "Needs you · \(min(needs, 99))" : "Needs you"
    case .working: return count > 0 ? "Working · \(min(count, 99))" : "Working"
    case .trouble: return "A message didn't send"
    case .done: return "Reply waiting"
    case .asleep: return "Dozing"
    case .idle:
      switch session {
      case .notConfigured: return "Not set up"
      case .notStarted: return "Not started"
      case .starting: return "Starting"
      case .restarting: return "Restarting"
      case .stopping: return "Stopping"
      case .stopped: return "Session stopped by you"
      case .blocked, .running: return "Ready"
      }
    }
  }

  /// "Talos, working": the VoiceOver label (agent name is sanitized like every label).
  public static func accessibility(agent: String, word: String) -> String {
    "\(label(agent)), \(word.lowercased())"
  }
}
