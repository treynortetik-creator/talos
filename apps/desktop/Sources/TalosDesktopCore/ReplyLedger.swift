import Foundation

/// A reply the page held back for him: its thread and the page's seq for it. The page keeps one per thread, the newest.
public struct HeldReply: Equatable, Hashable, Sendable {
  public var thread: String
  public var seq: Int
  public init(thread: String, seq: Int) {
    self.thread = thread
    self.seq = seq
  }
}

/// How a reply the page held back for him ends. The page is the authority: it holds a reply only while he has said he
/// delivers (`companion_replies {on:true}`), lists it in `companion_state.held`, and drops it when he says he showed it
/// (`shown`). It toasts whatever is still held the moment he says he stopped, or the shell is lost. So every held reply ends as
/// exactly one of:
///   bubble - he showed it (`shown`), and the message that acks it goes to the page;
///   banner - he posted the macOS banner (`banners`) and acked it in the same message, so the page does not toast it too;
///   toast  - he said nothing about it and the page showed its own toast (he stopped in a key window or in quiet hours).
/// This type is the pure rule for which, with no screen and no clock of its own, so it is tested without a GUI.
public struct ReplyLedger: Sendable {
  public struct Inputs: Sendable {
    /// The page's list, from its latest frame.
    public var held: [HeldReply]
    /// Threads whose turn is running: a held reply there waits for the turn (so its first line is real).
    public var working: Set<String>
    public var windowIsKey: Bool
    public var quiet: Bool
    /// He can say a reply right now (on screen, awake, not quiet, no mic, fed, the setting on, not outranked).
    public var canDeliver: Bool
    public var mono: TimeInterval
    /// The page's `replies_epoch` in that frame. A frame of another epoch is stale (sent before the page heard of this "on"): its
    /// list is not read. nil (an older page) is read as current.
    public var frameEpoch: Int?
    public init(
      held: [HeldReply] = [], working: Set<String> = [], windowIsKey: Bool = false, quiet: Bool = false, canDeliver: Bool = true,
      mono: TimeInterval = 0, frameEpoch: Int? = nil
    ) {
      self.frameEpoch = frameEpoch
      self.held = held
      self.working = working
      self.windowIsKey = windowIsKey
      self.quiet = quiet
      self.canDeliver = canDeliver
      self.mono = mono
    }
  }

  public struct Effects: Equatable, Sendable {
    /// The flag changed: tell the page.
    public var flag: Bool?
    /// Held replies the page should forget (shown, or posted as banners).
    public var ack: [HeldReply]
    /// Put these in the bubble now.
    public var deliver: [HeldReply]
    /// Post the fixed-phrase macOS banner for these (they are also in `ack`).
    public var banners: [HeldReply]
    public init(flag: Bool? = nil, ack: [HeldReply] = [], deliver: [HeldReply] = [], banners: [HeldReply] = []) {
      self.flag = flag
      self.ack = ack
      self.deliver = deliver
      self.banners = banners
    }
    /// A `companion_replies` message is due: the flag changed, or something was shown.
    public var send: Bool { flag != nil || !ack.isEmpty }
  }

  private enum Phase { case waiting, inFlight }
  private struct Item {
    var seq: Int
    var since: TimeInterval
    var phase: Phase
  }

  /// A reply that waits this long (mid-turn, say) is posted as a banner: it is not news any more, but it is not lost.
  public static let expiry: TimeInterval = 15 * 60

  public private(set) var flagOn = false
  /// Which "on" this is: it rises each time the flag comes on, and goes to the page with it.
  public private(set) var epoch = 0
  private var items: [String: Item] = [:]
  /// The highest seq acked per thread: the page may list a reply a while after he acked it.
  private var acked: [String: Int] = [:]

  public init() {}

  /// Every update: the flag, then what to deliver now.
  public mutating func update(_ i: Inputs) -> Effects {
    var fx = Effects()
    if flagOn, i.frameEpoch == nil || i.frameEpoch == epoch { ingest(i) }
    if i.canDeliver != flagOn {
      flagOn = i.canDeliver
      if flagOn { epoch += 1 }
      fx.flag = i.canDeliver
      if !flagOn { release(into: &fx, windowIsKey: i.windowIsKey, quiet: i.quiet) }
    }
    guard flagOn else { return fx }
    for (thread, it) in items.sorted(by: { $0.value.since < $1.value.since }) where it.phase == .waiting {
      let expired = i.mono - it.since >= Self.expiry
      if expired {
        if i.quiet { continue }  // nothing in quiet hours: the page keeps it for its toast
        fx.banners.append(HeldReply(thread: thread, seq: it.seq))
        fx.ack.append(HeldReply(thread: thread, seq: it.seq))
        acked[thread] = max(acked[thread] ?? -1, it.seq)
        items[thread] = nil
      } else if !i.working.contains(thread) {
        items[thread]?.phase = .inFlight
        fx.deliver.append(HeldReply(thread: thread, seq: it.seq))
      }
    }
    return fx
  }

  private mutating func ingest(_ i: Inputs) {
    let live = i.held.filter { $0.seq > (acked[$0.thread] ?? -1) }
    // What the page no longer lists was read, or already handled: forget it.
    items = items.filter { t, it in live.contains { $0.thread == t && $0.seq >= it.seq } }
    for h in live where (items[h.thread]?.seq ?? -1) < h.seq {
      // A newer reply in a thread already taken starts over (the page lists only the newest).
      items[h.thread] = Item(seq: h.seq, since: items[h.thread]?.since ?? i.mono, phase: .waiting)
    }
  }

  /// He stops delivering. Outside a key window, outside quiet hours, what he had taken becomes one banner each (acked in the
  /// same message). In a key window the owner is in the page, whose toast is the right delivery; in quiet hours there is no
  /// banner, and the page's toast is silent. Either way the page still holds them and toasts them.
  private mutating func release(into fx: inout Effects, windowIsKey: Bool, quiet: Bool) {
    if !windowIsKey && !quiet {
      for (thread, it) in items.sorted(by: { $0.value.since < $1.value.since }) {
        fx.banners.append(HeldReply(thread: thread, seq: it.seq))
        fx.ack.append(HeldReply(thread: thread, seq: it.seq))
        acked[thread] = max(acked[thread] ?? -1, it.seq)
      }
    }
    items = [:]
  }

  /// The bubble put these in front of the owner.
  public mutating func shown(_ hs: [HeldReply]) -> Effects {
    var fx = Effects()
    for h in hs {
      guard let it = items[h.thread] else { continue }  // released or forgotten meanwhile: the page has its own ending for it
      acked[h.thread] = max(acked[h.thread] ?? -1, h.seq)
      if it.seq <= h.seq { items[h.thread] = nil }  // a newer reply in the thread stays
      fx.ack.append(h)
    }
    return fx
  }

  /// The bubble could not show these (no room, the page went, he was snoozed, closed). In a key window they go back to waiting
  /// (the next update delivers them, or the flag goes off and the page toasts them); elsewhere they become banners unless it is
  /// quiet.
  public mutating func abandoned(_ hs: [HeldReply], windowIsKey: Bool, quiet: Bool) -> Effects {
    var fx = Effects()
    for h in hs {
      guard let it = items[h.thread], it.phase == .inFlight else { continue }
      if !windowIsKey && !quiet {
        fx.banners.append(HeldReply(thread: h.thread, seq: it.seq))
        fx.ack.append(HeldReply(thread: h.thread, seq: it.seq))
        acked[h.thread] = max(acked[h.thread] ?? -1, it.seq)
        items[h.thread] = nil
      } else {
        items[h.thread]?.phase = .waiting
      }
    }
    return fx
  }

  /// Teardown (off, hidden, snoozed, quit): the flag goes off now, by the same rules.
  public mutating func stop(windowIsKey: Bool, quiet: Bool) -> Effects {
    var fx = Effects()
    guard flagOn else { return fx }
    flagOn = false
    fx.flag = false
    release(into: &fx, windowIsKey: windowIsKey, quiet: quiet)
    return fx
  }
}
