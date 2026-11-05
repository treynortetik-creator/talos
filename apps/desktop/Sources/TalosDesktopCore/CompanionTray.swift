import Foundation

/// The status list (DESKTOP-COMPANION-SPEC 4.1, 4.2): the tray under the hover controls and the menu bar submenu show the
/// same rows. Pure: inputs in, rows out, so the states are tested without a screen. Names come from the page's thread list by
/// id (never by position), through `ComposeRules.labels` so equal names stay apart; an id the list does not hold reads
/// "A thread". No message text is here: a row is an id, a state word and a label.
public struct CompanionTray: Equatable, Sendable {
  public enum Action: Equatable, Sendable {
    /// Open this thread in Talos: `web.show()` then `navigate("/t/<id>")`.
    case thread(String)
    /// The Mac session itself: Show Terminal.
    case terminal
  }
  public struct Row: Equatable, Sendable {
    public var title: String
    public var word: String
    public var action: Action
    public init(title: String, word: String, action: Action) {
      self.title = title
      self.word = word
      self.action = action
    }
  }

  public static let maxRows = 8

  public init() {}

  public var rows: [Row] = []
  /// "+N more" opens Home.
  public var more = 0
  /// One line above or instead of the rows: "Checking…", "All quiet.", "Can't reach Talos", "Not connected".
  public var headline: String?
  /// "Reload Talos for the full list" for a page without `companion/1`.
  public var footer: String?
  /// Rows dimmed: the link is not online, so the counts may be stale.
  public var dimmed = false
  public var offersOpenTalos = false
  /// Empty and quiet: the tray draws Hello's still beside the headline.
  public var showsStill = false

  public static func word(_ s: CompanionFeed.RowState) -> String {
    switch s {
    case .needsYou: return "Needs you"
    case .ready: return "Reply waiting"
    case .working: return "Working"
    case .queued: return "Waiting its turn"
    case .onCall: return "On a call"
    }
  }

  /// `sessionTrouble` is the native "Session stopped" row (a stop that was not the owner's).
  public static func build(inputs i: CompanionInputs) -> CompanionTray {
    var t = CompanionTray()
    var native: [Row] = []
    if case .stopped(let byOwner) = i.session, !byOwner {
      native.append(Row(title: "Session", word: "Session stopped", action: .terminal))
    }
    switch i.pageStatus {
    case .down:
      t.headline = "Can't reach Talos"
      t.offersOpenTalos = true
      t.rows = native
      return t
    case .noFeed:
      t.rows = native
      t.footer = "Reload Talos for the full list"
      t.offersOpenTalos = true
      return t
    case .ready:
      break
    }
    guard let f = i.feed else {
      t.headline = "Checking…"
      t.rows = native
      return t
    }
    let labels = ComposeRules.labels(i.threads.map { WebToNative.Thread(id: $0.id, name: CompanionPhrase.label($0.name)) })
    var byId: [String: String] = [:]
    for (k, th) in i.threads.enumerated() where byId[th.id] == nil { byId[th.id] = labels[k] }
    let fromFeed = f.rows.map {
      Row(title: byId[$0.threadId] ?? "A thread", word: word($0.state), action: .thread($0.threadId))
    }
    let all = native + fromFeed
    t.rows = Array(all.prefix(maxRows))
    // The page lists at most `CompanionFeed.maxRows` threads. When it hit that cap, the true total is at least what its counts
    // say, so "+N more" and the button's count are not stuck at 12.
    var total = all.count
    if f.rows.count >= CompanionFeed.maxRows {
      total = max(total, native.count + f.needs + f.working + f.queued + f.onCall)
    }
    t.more = max(0, total - maxRows)
    if f.link != .online {
      t.dimmed = true
      t.headline = "Not connected"
    } else if all.isEmpty {
      t.headline = "All quiet."
      t.showsStill = true
    }
    return t
  }
}

/// Reply banners (spec 4.3). While he is on and can show the reply, the page's `New reply in` and `Answer ready in` banners
/// are dropped. Any other condition keeps today's banner, so a reply is never lost to a pet that can't show it.
public enum CompanionBannerPolicy {
  public struct Pet: Equatable, Sendable {
    /// Panels up: on, and not snoozed.
    public var onScreen: Bool
    /// The quiet decision: nil until known. Quiet means a statue with no bubbles.
    public var quiet: Bool?
    public var micRunning: Bool
    public var feedLive: Bool
    /// The state he is showing. Down, Needs you and Trouble outrank Done, so a reply would never get its bubble; Working defers
    /// it until the turn ends, which a mic, a reload or a silent feed can cancel, so the banner stays.
    public var state: CompanionState
    /// `companion.replyBanners`: the owner wants both.
    public var replyBanners: Bool
    public init(onScreen: Bool, quiet: Bool?, micRunning: Bool, feedLive: Bool, state: CompanionState, replyBanners: Bool) {
      self.onScreen = onScreen
      self.quiet = quiet
      self.micRunning = micRunning
      self.feedLive = feedLive
      self.state = state
      self.replyBanners = replyBanners
    }
  }

  public static func isReplyBanner(_ body: String) -> Bool {
    body.hasPrefix("New reply in ") || body.hasPrefix("Answer ready in ")
  }

  public static func drops(body: String, pet: Pet) -> Bool {
    guard isReplyBanner(body), NotificationPolicy.isPushPhrase(body), !pet.replyBanners else { return false }
    guard pet.onScreen, pet.quiet == false, !pet.micRunning, pet.feedLive else { return false }
    switch pet.state {
    case .down, .needsYou, .trouble: return false
    case .working: return false  // he can't announce it yet: the Done waits for the turn, and could be lost on the way
    case .done, .idle, .asleep: return true
    }
  }
}
