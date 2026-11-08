import CoreGraphics
import Foundation

/// Mini Talos delivers thread replies. Pure: what happens to a reply, the words in his bubble, how several replies pile into one,
/// where Open goes, and where the bubble sits. No screen, no page, so every case is a test.
public enum ReplyRoute: Equatable, Sendable {
  /// He says it. The page's banner is dropped.
  case bubble
  /// Today's macOS banner.
  case banner
  /// The owner is looking at that thread: neither.
  case nothing
}

public enum ReplyDelivery {
  /// `/t/<id>` (a query or fragment is ignored) -> `<id>`. Anything else, or an id the page would not use, is nil.
  public static func threadId(inPath path: String?) -> String? {
    guard let path, path.hasPrefix("/t/") else { return nil }
    let rest = path.dropFirst(3).prefix { $0 != "?" && $0 != "#" }
    let id = String(rest)
    return ThreadIdRule.isValid(id) ? id : nil
  }

  /// What to do with the page's banner `body`, which asks to open `navigate`. Only the two reply phrases are ever touched.
  /// The thread on screen gets nothing in any case; otherwise his bubble replaces the banner exactly when
  /// `CompanionBannerPolicy` says he can show it.
  public static func route(body: String, navigate: String, pet: CompanionBannerPolicy.Pet) -> ReplyRoute {
    guard CompanionBannerPolicy.isReplyBanner(body), NotificationPolicy.isPushPhrase(body) else { return .banner }
    let thread = threadId(inPath: navigate)
    // Only a KEY window is being read. A window that is merely visible still gets the banner (or his bubble).
    if pet.windowIsKey, let viewing = pet.viewedThread, thread == viewing { return .nothing }
    return CompanionBannerPolicy.drops(body: body, pet: pet, thread: thread) ? .bubble : .banner
  }
}

/// What the reply bubble says. One entry per thread, in the order the replies came, the newest last.
public struct ReplyBubbleContent: Equatable, Sendable {
  public struct Item: Equatable, Sendable {
    public var id: String
    public var name: String
    /// The page's seq for a held reply (the page forgets it once he says he showed it); nil for the reducer's own bubble.
    public var seq: Int?
  }

  /// It stays until Open or Later, or this long. A pointer on it pauses the clock; a new reply restarts it.
  public static let lifetime: TimeInterval = 30
  /// Names listed in a bubble that holds several replies; more are "…".
  public static let maxNames = 2
  /// The first line is cut here, with "…".
  public static let maxLine = 70

  public private(set) var items: [Item] = []
  /// The first line of the newest reply (one thread only; it means nothing for several).
  public var line: String?

  public init() {}

  public var count: Int { items.count }

  /// A reply in `id`. A thread already listed is not listed twice: it moves to the newest place. The old line is forgotten. A
  /// seq is kept, and only ever rises.
  public mutating func add(thread id: String, name: String, seq: Int? = nil) {
    let kept = items.first { $0.id == id }?.seq
    items.removeAll { $0.id == id }
    items.append(Item(id: id, name: name, seq: [kept, seq].compactMap { $0 }.max()))
    line = nil
  }

  /// Takes the page's held replies out (the ledger gave them back to the page); the reducer's own stay.
  public mutating func removeHeld() { items.removeAll { $0.seq != nil } }

  /// The held replies in this bubble: what to tell the page when it is shown.
  public var held: [HeldReply] { items.compactMap { i in i.seq.map { HeldReply(thread: i.id, seq: $0) } } }

  private var labels: [String] {
    var seen = Set<String>()
    return items.map { CompanionPhrase.label($0.name) }.filter { seen.insert($0).inserted }
  }

  public var header: String {
    guard let only = items.first, count == 1 else { return "\(count) new replies" }
    return CompanionPhrase.label(only.name).uppercased() + " · new reply"
  }

  public var body: String {
    if count == 1 { return line ?? "Open to read it." }
    let all = labels
    return all.prefix(Self.maxNames).joined(separator: ", ") + (all.count > Self.maxNames ? "…" : "")
  }

  /// The VoiceOver line.
  public var spoken: String {
    guard let only = items.first, count == 1 else { return "\(header): \(body)" }
    return "New reply in \(CompanionPhrase.label(only.name)): \(body)"
  }

  /// A thread for one reply; Home for several, which shows them all (a thread would hide the others).
  public var openPath: String {
    guard let only = items.first, count == 1 else { return "/" }
    return "/t/\(only.id)"
  }

  /// The first real line of a reply, for the bubble: control and bidi characters out, simple Markdown marks out, spaces
  /// collapsed, cut at `maxLine` with "…". `truncated` is the page saying it cut the text itself.
  public static func firstLine(of text: String, truncated: Bool = false) -> String? {
    let lines = CompanionPhrase.replyText(text).split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
    for (i, raw) in lines.enumerated() {
      var s = raw.replacingOccurrences(of: "**", with: "").replacingOccurrences(of: "__", with: "").replacingOccurrences(of: "`", with: "")
      s = String(s.drop { "#>-*• \t".contains($0) })
      s = s.split(whereSeparator: { $0 == " " || $0 == "\t" }).joined(separator: " ")
      if s.isEmpty { continue }
      if s.count > maxLine {
        var cut = String(s.prefix(maxLine))
        if let space = cut.lastIndex(of: " "), cut.distance(from: cut.startIndex, to: space) > maxLine - 20 {
          cut = String(cut[..<space])
        }
        return cut.trimmingCharacters(in: .whitespaces) + "…"
      }
      let lastLine = !lines[(i + 1)...].contains { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
      return truncated && lastLine ? s + "…" : s
    }
    return nil
  }
}

extension NotificationPolicy {
  /// The banner he posts himself when he took a reply and then could not show it (a call began). The page's own banner for the
  /// thread has the same tag, so the two replace each other and the 60 s limit covers both.
  public static func replyBanner(agent: String, thread name: String, id: String) -> NativeNotice {
    var body = "New reply in \(CompanionPhrase.label(name))"
    if !isPushPhrase(body) { body = "New activity" }  // the same gate as every page-requested banner
    return NativeNotice(title: cleanAgentName(agent), body: body, navigate: "/t/\(id)", tag: "web:thread:\(id)", quiet: false)
  }
}

extension CompanionPlacement {
  public static let replyBubbleWidth: CGFloat = 280

  /// The reply bubble: above him by default, below at the top edge, past `past` (the hover controls) on the same side, on screen.
  public static func replyBubbleFrame(sprite: CGRect, size: CGSize, past: CGRect?, in v: CGRect) -> CGRect {
    let w = min(size.width, v.width)
    let h = min(size.height, v.height)
    let x = min(max(sprite.midX - w / 2, v.minX), max(v.minX, v.maxX - w))
    var top = sprite.maxY
    var bottom = sprite.minY
    if let c = past {
      if c.minY >= sprite.maxY - 0.5 { top = c.maxY } else if c.maxY <= sprite.minY + 0.5 { bottom = c.minY }
    }
    if top + gap + h <= v.maxY { return CGRect(x: x, y: top + gap, width: w, height: h) }
    let belowY = bottom - gap - h
    if belowY >= v.minY { return CGRect(x: x, y: belowY, width: w, height: h) }
    return CGRect(x: x, y: max(v.minY, v.maxY - h), width: w, height: h)
  }
}
