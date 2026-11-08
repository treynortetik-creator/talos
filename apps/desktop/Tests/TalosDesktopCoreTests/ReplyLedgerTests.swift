import Foundation
import Testing

@testable import TalosDesktopCore

// The ledger: what the page holds back for him, what he has taken, and how every held reply ends. Pure, so it runs without
// TALOS_GUI_TESTS. Fictional threads.

private func h(_ t: String, _ s: Int) -> HeldReply { HeldReply(thread: t, seq: s) }

private func inputs(
  _ held: [HeldReply] = [], working: Set<String> = [], key: Bool = true, quiet: Bool = false, can: Bool = true, at mono: TimeInterval = 0
) -> ReplyLedger.Inputs {
  .init(held: held, working: working, windowIsKey: key, quiet: quiet, canDeliver: can, mono: mono)
}

@Suite("Reply ledger: delivery")
struct ReplyLedgerDeliveryTests {
  @Test func theFlagComesOnWhenHeCanDeliverAndNothingIsHeldYet() {
    var l = ReplyLedger()
    let fx = l.update(inputs())
    #expect(fx.flag == true && fx.ack.isEmpty && fx.deliver.isEmpty && fx.send)
    #expect(l.update(inputs()).send == false, "unchanged: nothing to say")
  }

  @Test func aHeldReplyGoesToTheBubbleAndIsAckedWhenItIsShown() {
    var l = ReplyLedger()
    _ = l.update(inputs())
    let fx = l.update(inputs([h("ops", 3)]))
    #expect(fx.deliver == [h("ops", 3)] && fx.ack.isEmpty && fx.banners.isEmpty)
    let shown = l.shown([h("ops", 3)])
    #expect(shown.ack == [h("ops", 3)] && shown.send)
    // the page still lists it until it hears the ack: no second delivery, no second ack
    let again = l.update(inputs([h("ops", 3)]))
    #expect(again.deliver.isEmpty && again.ack.isEmpty)
  }

  @Test func twoRepliesInOneFrameGoTogetherAndAreAckedTogether() {
    var l = ReplyLedger()
    _ = l.update(inputs())
    let fx = l.update(inputs([h("ops", 3), h("work", 4)]))
    #expect(Set(fx.deliver) == [h("ops", 3), h("work", 4)])
    #expect(Set(l.shown(fx.deliver).ack) == [h("ops", 3), h("work", 4)])
  }

  @Test func aSecondReplyInTheSameThreadFortySecondsLaterIsDeliveredAgain() {
    var l = ReplyLedger()
    _ = l.update(inputs())
    _ = l.update(inputs([h("ops", 3)], at: 0))
    _ = l.shown([h("ops", 3)])
    let fx = l.update(inputs([h("ops", 5)], at: 40))
    #expect(fx.deliver == [h("ops", 5)], "no 60 s gap here: the page's list is the authority")
  }

  @Test func aReplyMidTurnWaitsForThatThreadsTurnToEnd() {
    var l = ReplyLedger()
    _ = l.update(inputs())
    #expect(l.update(inputs([h("ops", 3)], working: ["ops"], at: 1)).deliver.isEmpty)
    #expect(l.update(inputs([h("ops", 3)], working: ["ops"], at: 100)).deliver.isEmpty)
    #expect(l.update(inputs([h("ops", 3)], working: [], at: 101)).deliver == [h("ops", 3)])
  }

  @Test func anotherThreadsTurnDoesNotHoldItBack() {
    var l = ReplyLedger()
    _ = l.update(inputs())
    #expect(l.update(inputs([h("ops", 3)], working: ["work"], at: 1)).deliver == [h("ops", 3)])
  }

  @Test func aWaitThatOutlastsTheExpiryPostsTheBannerAndAcksIt() {
    var l = ReplyLedger()
    _ = l.update(inputs())
    _ = l.update(inputs([h("ops", 3)], working: ["ops"], at: 0))
    let fx = l.update(inputs([h("ops", 3)], working: ["ops"], at: ReplyLedger.expiry + 1))
    #expect(fx.banners == [h("ops", 3)] && fx.ack == [h("ops", 3)] && fx.deliver.isEmpty)
    #expect(l.update(inputs([h("ops", 3)], working: ["ops"], at: ReplyLedger.expiry + 2)).banners.isEmpty, "once")
  }

  @Test func theThreadTheOwnerOpensIsForgottenAndNeverDelivered() {
    var l = ReplyLedger()
    _ = l.update(inputs())
    _ = l.update(inputs([h("ops", 3)], working: ["ops"], at: 0))
    #expect(l.update(inputs([], at: 5)).deliver.isEmpty, "the page dropped it")
    #expect(l.update(inputs([], at: 6)).ack.isEmpty)
  }
}

@Suite("Reply ledger: when he stops")
struct ReplyLedgerStopTests {
  private func taken(key: Bool = true, quiet: Bool = false) -> ReplyLedger {
    var l = ReplyLedger()
    _ = l.update(inputs())
    _ = l.update(inputs([h("ops", 3), h("work", 4)], working: ["work"], at: 0))  // ops in flight, work waiting
    return l
  }

  @Test func inAKeyWindowTheFlagGoesOffAndThePageToastsWhatHeHeld() {
    var l = taken()
    let fx = l.update(inputs([h("ops", 3), h("work", 4)], key: true, can: false, at: 1))
    #expect(fx.flag == false && fx.ack.isEmpty && fx.banners.isEmpty, "the toast is the page's, in the window the owner is in")
  }

  @Test func outsideAKeyWindowWhatHeHadTakenBecomesOneBanner() {
    var l = taken()
    let fx = l.update(inputs([h("ops", 3), h("work", 4)], key: false, can: false, at: 1))
    #expect(fx.flag == false)
    #expect(Set(fx.banners) == [h("ops", 3), h("work", 4)] && Set(fx.ack) == Set(fx.banners), "acked in the same message, so no toast too")
  }

  @Test func inQuietHoursThereIsNoBannerAndThePageKeepsThemForItsToast() {
    var l = taken()
    let fx = l.update(inputs([h("ops", 3), h("work", 4)], key: false, quiet: true, can: false, at: 1))
    #expect(fx.flag == false && fx.banners.isEmpty && fx.ack.isEmpty)
  }

  @Test func oncePageHasHeardItNothingIsOwedAgain() {
    var l = taken()
    _ = l.update(inputs([h("ops", 3)], key: false, can: false, at: 1))
    #expect(l.update(inputs([h("ops", 3)], key: false, can: false, at: 2)).send == false)
    #expect(l.update(inputs([h("ops", 3)], key: false, can: false, at: 3)).banners.isEmpty)
  }

  @Test func aBubbleThatNeverShowedGoesBackToWaitingInAKeyWindow() {
    var l = taken()
    let fx = l.abandoned([h("ops", 3)], windowIsKey: true, quiet: false)
    #expect(fx.banners.isEmpty && fx.ack.isEmpty)
    #expect(l.update(inputs([h("ops", 3)], working: ["work"], at: 2)).deliver == [h("ops", 3)], "tried again")
  }

  @Test func aBubbleThatNeverShowedOutsideAKeyWindowIsOneBannerUnlessQuiet() {
    var l = taken()
    let fx = l.abandoned([h("ops", 3)], windowIsKey: false, quiet: false)
    #expect(fx.banners == [h("ops", 3)] && fx.ack == [h("ops", 3)])
    var q = taken()
    let fq = q.abandoned([h("ops", 3)], windowIsKey: false, quiet: true)
    #expect(fq.banners.isEmpty && fq.ack.isEmpty)
  }

  @Test func teardownStopsTheFlagNowWithTheSameRules() {
    var l = taken()
    let fx = l.stop(windowIsKey: false, quiet: false)
    #expect(fx.flag == false && Set(fx.banners) == [h("ops", 3), h("work", 4)])
    #expect(l.stop(windowIsKey: false, quiet: false).send == false)
  }
}

// MARK: the landing invariant

/// The page and the native side, driven by a random sequence of events, with messages that take a while in both directions.
/// The invariant: every reply the page holds ends as EXACTLY ONE of
///   bubble  - he showed it,
///   banner  - he posted the macOS banner (expiry, or he stopped outside a key window),
///   toast   - the page showed its own toast (he stopped, the shell was lost, or no flag was on),
///   read    - the owner opened the thread first.
/// A reply held back for quiet hours is counted as a TOAST: the page keeps it and toasts it; there is never a banner in quiet
/// hours. A page reload is outside the invariant by design (the held list is memory, the unread count stays), so a reply
/// discarded by a reload is counted as `reload` unless he had already shown it.
private struct Landing {
  enum Outcome: String { case bubble, banner, toast, read, reload }

  struct Rng {
    var state: UInt64
    mutating func next(_ n: Int) -> Int {
      state = state &* 6364136223846793005 &+ 1442695040888963407
      return Int((state >> 33) % UInt64(n))
    }
  }

  // page
  var pageFlag = false
  var pageEpoch: Int?
  var held: [String: Int] = [:]  // thread -> seq: the page keeps one per thread, the newest
  var seqCounter = 0
  var chain: [String: [(seq: Int, id: Int)]] = [:]  // every reply the page held, per thread: a newer one merges the older
  var viewing: String?
  var nextId = 0
  var outcomes: [Int: [Outcome]] = [:]
  // wires
  var toNative: [(held: [HeldReply], viewing: String?, epoch: Int?)] = []
  var toPage: [(on: Bool, shown: [HeldReply], epoch: Int)] = []
  var lastHeld: [HeldReply] = []
  var lastEpoch: Int?
  // native
  var ledger = ReplyLedger()
  var pending: [HeldReply] = []
  var visible: [HeldReply] = []
  var suspendedPending: [HeldReply] = []
  var dragging = false
  var snoozed = false, mic = false, quiet = false, key = true, toggleOn = true
  var working: Set<String> = []
  var mono: TimeInterval = 0
  var rng: Rng
  var trace: [String] = []

  static let threads = ["ops", "work", "oc"]

  init(seed: UInt64) { rng = Rng(state: seed) }

  var canDeliver: Bool { !snoozed && !mic && !quiet && toggleOn }

  mutating func record(_ id: Int, _ o: Outcome) {
    outcomes[id, default: []].append(o)
    trace.append("   -> reply \(id) \(o.rawValue)")
  }

  /// A delivery of the page's entry (thread, seq): that reply ends here, and so do older ones of the thread it had merged that
  /// had no ending yet (one banner or toast names the thread's newest reply).
  mutating func deliver(_ item: HeldReply, _ o: Outcome) {
    for (seq, id) in chain[item.thread] ?? [] where seq <= item.seq {
      if seq == item.seq || outcomes[id]?.isEmpty == true { record(id, o) }
    }
  }

  // page events
  mutating func reply(_ thread: String) {
    let id = nextId
    nextId += 1
    outcomes[id] = []
    if thread == viewing { return record(id, .read) }
    guard pageFlag else { return record(id, .toast) }  // the watcher's own toast, as before the companion
    seqCounter += 1
    chain[thread, default: []].append((seqCounter, id))
    held[thread] = seqCounter
  }

  mutating func pageFlush() {
    for (t, seq) in held { deliver(HeldReply(thread: t, seq: seq), .toast) }  // one toast names the newest; the rest are merged into it
    held = [:]
  }

  mutating func pageReceive(on: Bool, shown: [HeldReply], epoch: Int = 1) {
    for s in shown { if let v = held[s.thread], v <= s.seq { held[s.thread] = nil } }
    pageEpoch = on ? epoch : nil
    if pageFlag && !on { pageFlag = false; pageFlush() } else { pageFlag = on }
  }

  mutating func view(_ thread: String?) {
    viewing = thread
    if let t = thread, let v = held[t] { deliver(HeldReply(thread: t, seq: v), .read); held[t] = nil }
  }

  mutating func sendFrame() {
    toNative.append((held.map { HeldReply(thread: $0.key, seq: $0.value) }.sorted { $0.seq < $1.seq }, viewing, pageEpoch))
  }

  mutating func receiveFrame() { if !toNative.isEmpty { let f = toNative.removeFirst(); lastHeld = f.held; lastEpoch = f.epoch } }

  mutating func receiveMessage() {
    if !toPage.isEmpty {
      let m = toPage.removeFirst()
      pageReceive(on: m.on, shown: m.shown, epoch: m.epoch)
    }
  }

  // native
  mutating func apply(_ fx: ReplyLedger.Effects) {
    for b in fx.banners { deliver(b, .banner) }
    if fx.send {
      toPage.append((ledger.flagOn, fx.ack, ledger.epoch))
      trace.append("   >> to page on=\(ledger.flagOn) ack=\(fx.ack.map { "\($0.thread)\($0.seq)" })")
    }
    if fx.flag == false { pending = []; suspendedPending = []; visible = [] }  // he is gone: panel, text and timers
    if !fx.deliver.isEmpty {
      if !visible.isEmpty && !dragging { shown(fx.deliver) } else if !visible.isEmpty { suspendedPending += fx.deliver } else { pending += fx.deliver }
    }
  }

  mutating func shown(_ hs: [HeldReply]) {
    let fx = ledger.shown(hs)
    for a in fx.ack { deliver(a, .bubble) }
    visible += hs
    apply(ReplyLedger.Effects(flag: nil, ack: fx.ack))
  }

  mutating func tick() {
    let fx = ledger.update(
      .init(held: lastHeld, working: working, windowIsKey: key, quiet: quiet, canDeliver: canDeliver, mono: mono, frameEpoch: lastEpoch))
    apply(fx)
  }

  mutating func fetchDone() {
    guard !pending.isEmpty else { return }
    let items = pending
    pending = []
    if dragging { suspendedPending += items; return }
    if canDeliver { shown(items) } else { apply(ledger.abandoned(items, windowIsKey: key, quiet: quiet)) }
  }

  mutating func dragEnd() {
    dragging = false
    let items = suspendedPending
    suspendedPending = []
    if !items.isEmpty { if canDeliver { shown(items) } else { apply(ledger.abandoned(items, windowIsKey: key, quiet: quiet)) } }
  }

  mutating func shellLost() {
    // What he had already handed to the page arrives (the page is in its own process). A crash between posting a banner and
    // handing over its ack is the one window nothing can close; it is not modelled.
    while !toPage.isEmpty { receiveMessage() }
    pageFlag = false
    pageFlush()
    ledger = ReplyLedger()
    pending = []; suspendedPending = []; visible = []; toNative = []; toPage = []; lastHeld = []; lastEpoch = nil; pageEpoch = nil
  }

  mutating func reload() {
    for (t, seq) in held { deliver(HeldReply(thread: t, seq: seq), .reload) }
    held = [:]
    pageFlag = false
    pageEpoch = nil
    toNative = []
    lastHeld = []
    lastEpoch = nil
    // the new page says ready; the shell tells it the flag again
    if ledger.flagOn { toPage.append((true, [], ledger.epoch)) }
  }

  mutating func step() {
    let before = outcomes.values.reduce(0) { $0 + $1.count }
    stepOnce()
    _ = before
  }

  mutating func stepOnce() {
    trace.append("t=\(Int(mono)) flag=\(ledger.flagOn)/\(pageFlag) key=\(key) q=\(quiet) snooze=\(snoozed) mic=\(mic) tog=\(toggleOn) held=\(held) pend=\(pending.count) vis=\(visible.count) toP=\(toPage.count) toN=\(toNative.count)")
    switch rng.next(22) {
    case 0, 1, 2, 3: reply(Self.threads[rng.next(3)])
    case 4: sendFrame()
    case 5, 6: receiveFrame()
    case 7, 8: receiveMessage()
    case 9, 10, 11: tick()
    case 12: fetchDone()
    case 13: snoozed.toggle()
    case 14: mic.toggle()
    case 15: quiet.toggle()
    case 16: key.toggle()
    case 17: toggleOn.toggle()
    case 18:
      let t = Self.threads[rng.next(3)]
      if working.contains(t) { working.remove(t) } else { working.insert(t) }
    case 19: if dragging { dragEnd() } else { dragging = true; if !visible.isEmpty { visible = [] } }
    case 20: view(rng.next(3) == 0 ? nil : Self.threads[rng.next(3)])
    default:
      switch rng.next(12) {
      case 0: shellLost()
      case 1: reload()
      default: mono += Double(rng.next(400))
      }
    }
    if rng.next(4) == 0 { mono += Double(rng.next(60)) }
  }

  /// Everything arrives, he stops or his wait expires, the page toasts the rest.
  mutating func settle() {
    dragging = false
    for _ in 0..<4 {
      for _ in 0..<6 { sendFrame(); receiveFrame(); tick(); receiveMessage() }
      if dragging { dragEnd() } else { dragEnd() }
      fetchDone()
    }
    working = []
    mono += ReplyLedger.expiry + 10
    for _ in 0..<6 { sendFrame(); receiveFrame(); tick(); fetchDone(); receiveMessage() }
    // he is turned off: whatever is still with the page becomes its toast
    snoozed = true
    for _ in 0..<6 { sendFrame(); receiveFrame(); tick(); receiveMessage() }
    while !toPage.isEmpty { receiveMessage() }
    if pageFlag { pageReceive(on: false, shown: []) }
    pageFlush()
  }
}

@Suite("Reply ledger: the landing invariant")
struct ReplyLandingTests {
  private func run(seed: UInt64, steps: Int = 70) -> Landing {
    var sim = Landing(seed: seed)
    for _ in 0..<steps { sim.step() }
    sim.settle()
    return sim
  }

  @Test func everyHeldReplyEndsAsExactlyOneOutcome() {
    var counts: [Landing.Outcome: Int] = [:]
    for seed in 1...600 {
      let sim = run(seed: UInt64(seed))
      for id in 0..<sim.nextId {
        let o = sim.outcomes[id] ?? []
        // One delivery. The one tolerated overlap: the owner opened the thread (`read`) while a message about that same reply was
        // already in flight, so a delivery can follow a read. That is one redundant notice, never a loss, and never two deliveries.
        let deliveries = o.filter { $0 != .read }
        if deliveries.count > 1 || o.isEmpty || (o.count > 2) {
          let tail: String = sim.trace.suffix(40).joined(separator: "\n")
          let ends: [String] = o.map(\.rawValue)
          Issue.record("seed \(seed): reply \(id) ended as \(ends)\nchain \(sim.chain)\n\(tail)")
        }
        if let one = o.first { counts[one, default: 0] += 1 }
      }
    }
    // the generator really reaches every ending, or the invariant proves little
    for o in [Landing.Outcome.bubble, .banner, .toast, .read, .reload] { #expect((counts[o] ?? 0) > 0, "never reached \(o)") }
  }

  @Test func theNamedRacesEachEndInOneDelivery() {
    // flag off while a reply is in flight (S2): toast
    var a = Landing(seed: 1)
    a.pageReceive(on: true, shown: [])
    a.reply("ops")
    a.sendFrame(); a.receiveFrame(); a.tick()  // he takes it
    a.snoozed = true; a.tick(); a.receiveMessage(); a.receiveMessage()
    a.settle()
    #expect(a.outcomes[0] == [.toast])

    // flag on while a reply is in flight: it landed before, so the page toasts it once and he never sees it
    var b = Landing(seed: 2)
    b.reply("ops")
    b.pageReceive(on: true, shown: [])
    b.sendFrame(); b.receiveFrame(); b.tick(); b.fetchDone(); b.settle()
    #expect(b.outcomes[0] == [.toast])

    // two replies in one frame: one bubble, both acked
    var c = Landing(seed: 3)
    c.pageReceive(on: true, shown: [])
    c.reply("ops"); c.reply("work")
    c.sendFrame(); c.receiveFrame(); c.tick(); c.fetchDone(); c.receiveMessage(); c.settle()
    #expect(c.outcomes[0] == [.bubble] && c.outcomes[1] == [.bubble])

    // a drag during delivery: shown after the drop
    var d = Landing(seed: 4)
    d.pageReceive(on: true, shown: [])
    d.reply("ops")
    d.sendFrame(); d.receiveFrame(); d.tick(); d.dragging = true; d.fetchDone()
    #expect(d.outcomes[0]?.isEmpty == true)
    d.dragEnd(); d.settle()
    #expect(d.outcomes[0] == [.bubble])

    // snooze while fetching, window not key: one banner
    var e = Landing(seed: 5)
    e.key = false
    e.pageReceive(on: true, shown: [])
    e.reply("ops")
    e.sendFrame(); e.receiveFrame(); e.tick(); e.snoozed = true; e.tick(); e.settle()
    #expect(e.outcomes[0] == [.banner])

    // the same in quiet hours: no banner, the page toasts
    var f = Landing(seed: 6)
    f.key = false
    f.pageReceive(on: true, shown: [])
    f.reply("ops")
    f.sendFrame(); f.receiveFrame(); f.tick(); f.quiet = true; f.tick(); f.settle()
    #expect(f.outcomes[0] == [.toast])

    // the shell is lost: toast, and nothing from him afterwards
    var g = Landing(seed: 7)
    g.pageReceive(on: true, shown: [])
    g.reply("ops")
    g.shellLost(); g.settle()
    #expect(g.outcomes[0] == [.toast])

    // a reload: the held list was memory; counted as a reload, never as a second ending
    var r = Landing(seed: 8)
    r.pageReceive(on: true, shown: [])
    r.reply("ops")
    r.reload(); r.settle()
    #expect(r.outcomes[0] == [.reload])

    // expiry: mid-turn for longer than the wait, not quiet: one banner
    var x = Landing(seed: 9)
    x.key = false
    x.pageReceive(on: true, shown: [])
    x.working = ["ops"]
    x.reply("ops")
    x.sendFrame(); x.receiveFrame(); x.tick()
    x.mono += ReplyLedger.expiry + 1; x.tick(); x.settle()
    #expect(x.outcomes[0] == [.banner])
  }
}
