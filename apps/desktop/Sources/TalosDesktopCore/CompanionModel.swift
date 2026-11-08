import Foundation

// The companion's brain (DESKTOP-COMPANION-SPEC 2): a pure reducer. Inputs and a clock go in, a picture comes out. It owns
// no timers: it returns the next moment it needs to be asked again, and the controller schedules one one-shot for it.
//
// State 2 ("On a call") exists in the spec but nothing emits `on_call` today, so it has no case here and the PR does not
// claim it. Trouble and Done need the C-FEED message and arrive with C-LIVE.

public enum CompanionState: String, Equatable, Sendable, CaseIterable {
  case down, needsYou, trouble, done, working, idle, asleep

  var priority: Int {
    switch self {
    case .down: return 5
    case .needsYou: return 4
    case .trouble: return 3
    case .done: return 2
    case .working: return 1
    case .idle, .asleep: return 0
    }
  }
}

/// A thread the page listed: its id and its name (the real thread name since O20; Mac notifications never read this list). Core's own type so the app target can build it.
public struct CompanionThreadRef: Equatable, Sendable {
  public var id: String
  public var name: String
  public init(id: String, name: String) {
    self.id = id
    self.name = name
  }
}

/// What the Mac knows about the Talos page, for the tray's states (spec 4.2).
public enum CompanionPageStatus: Equatable, Sendable {
  /// Not loaded, or not signed in.
  case down
  /// Signed in, but the page does not advertise `companion/1` (an older page).
  case noFeed
  case ready
}

/// The session as the companion sees it. `TalosDesktopCore` can't import the supervisor, and a stop is only a string in
/// `HealthModel`, so `StatusCoordinator` fills this from `.stopped(.user)` and never compares the text.
public enum CompanionSession: Equatable, Sendable {
  case notConfigured, notStarted, starting, running(busy: Bool), restarting, stopping, blocked
  case stopped(byOwner: Bool)
}

public struct CompanionInputs: Equatable, Sendable {
  public var session: CompanionSession = .notConfigured
  /// The session itself needs the owner at the Mac (a dialog, stuck, a cold-start confirm).
  public var sessionNeedsYou = false
  /// The page's Needs-you count (`WebController.needsYou`).
  public var needs = 0
  /// The relay poll has failed twice running (counted in `StatusCoordinator`).
  public var relayDown = false
  public var agentName = "Talos"
  /// nil until the first `readBridge` has returned: no beat, Morning or quiet decision before that.
  public var quiet: Bool?
  public var quietWindow: QuietWindow?
  /// Banners dropped inside the quiet window since launch. Morning reports the ones since the last Morning.
  public var collected = 0
  /// The page's `companion_state` while it is live (C-FEED), else nil: the pet then runs on the native inputs above.
  public var feed: CompanionFeed?
  public var pageStatus: CompanionPageStatus = .down
  /// `web.threads`, for names in bubbles and the tray.
  public var threads: [CompanionThreadRef] = []
  /// The Talos window is the key window: the owner is in it, and the page's own list of held replies (see `ReplyLedger`) tells
  /// him about them. The reducer announces no reply then, or he would be told twice.
  public var windowIsKey = false
  /// The thread the page says is on screen (`companion_state.viewing`, a card page counting as its thread), else nil. It only
  /// matters while the window is key.
  public var viewedThread: String?

  public init() {}

  /// The Needs-you count: the feed's when it is live, else the page badge.
  public var effectiveNeeds: Int { feed?.needs ?? needs }
  /// Working plus queued from the feed, 0 without it.
  public var workCount: Int { feed.map { $0.working + $0.queued } ?? 0 }
}

public struct CompanionEnv: Equatable, Sendable {
  /// A microphone has been running (already holds the 30 s tail).
  public var micRunning = false
  public var reduceMotion = false
  public var lowPower = false
  public var mini = false
  /// `companion.moments`: Rounds, the idle antics and the short wanders. Other beats are direct reactions and stay.
  public var moments = true
  /// The idle antics the art has, each with how long it plays (seconds): the controller fills this from the manifest, so an art
  /// bundle without an antic never has it picked. The default is the idle pool (a test pins it to the real manifest).
  public var antics: [String: TimeInterval] = CompanionModel.idleAntics
  /// The same for Needs you: the clips he rotates through while he waits for you (the rock, the glance and the blink are his base loop).
  public var needsClips: [String: TimeInterval] = CompanionModel.needsAntics
  /// Seconds since the owner last touched the Mac (keyboard or mouse). Rounds may wake him only within 60.
  public var secondsSinceInput: Double = .infinity
  /// A speech bubble or a reply card is open: no antic starts under it.
  public var bubbleOpen = false
  /// The tray, the compose box, the controls or a resting pointer: the owner is right there, so no antic starts.
  public var anticHold = false

  public init() {}
  /// Every state shows its still.
  public var stillOnly: Bool { reduceMotion || lowPower }
}

/// A clip the sprite plays once or for a while, then rests.
public struct CompanionAnimation: Equatable, Sendable {
  public var clip: String
  /// Play only the first n frames (the Poke hop is the first four `jumping` frames).
  public var frameLimit: Int?
  /// Repeat the clip for this long (Working runs for 20 s; Talking for 1.2 s).
  public var repeatFor: TimeInterval?
  /// Loop until the model clears it (Carried).
  public var untilCleared = false
  public var seq: Int
  public init(clip: String, frameLimit: Int? = nil, repeatFor: TimeInterval? = nil, untilCleared: Bool = false, seq: Int) {
    self.clip = clip
    self.frameLimit = frameLimit
    self.repeatFor = repeatFor
    self.untilCleared = untilCleared
    self.seq = seq
  }
}

/// Where the sprite comes to rest after an animation.
public enum CompanionRest: Equatable, Sendable {
  case idle  // open eyes, planned blinks
  case statue
  case nap  // Asleep (not quiet): lying down, eyes shut and dim, one still frame, no animation
  case holdStill(String)  // the clip's `still` frame
  case holdLast(String)  // the clip's last frame
}

public struct CompanionBubbleEvent: Equatable, Sendable {
  public var bubble: CompanionBubble
  public var seq: Int
}

public struct CompanionOutput: Equatable, Sendable {
  public var state: CompanionState
  /// The quiet window is on. It silences bubbles, banners and sounds and adds the overnight dot; it never changes how he looks
  /// or moves.
  public var quiet: Bool
  public var animation: CompanionAnimation?
  public var rest: CompanionRest
  public var bubble: CompanionBubbleEvent?
  public var word: String
  public var accessibilityLabel: String
  /// A still dot: something collected overnight (quiet), or nothing yet.
  public var dot: Bool
  public var dragging: Bool
  /// A Rounds slot is due and every clamp allows it. The controller checks the physical conditions (pointer, open panels),
  /// then calls `roundsStarted` or `roundsDeclined`.
  public var roundsDue: Bool
  /// A short wander is due and every clamp allows it. The controller checks the physical conditions (pointer, open panels), then
  /// calls `wanderStarted` or `wanderDeclined`.
  public var wanderDue = false
  /// Bumps when an idle antic that was playing must stop now (the owner came back, a clamp closed, a state took over). The view
  /// cuts a running antic to its rest on a new value and ignores it for any other clip.
  public var anticStop: Int
  /// Ask again at this monotonic time (nil: nothing pending).
  public var nextDeadline: TimeInterval?
}

public struct CompanionModel {
  // Tunables, named so the tests can use them.
  public static let enterWorking: TimeInterval = 1.5
  public static let leaveWorking: TimeInterval = 4
  public static let minChange: TimeInterval = 3
  public static let asleepAfter: TimeInterval = 1800
  public static let workingRun: TimeInterval = 20
  public static let needsSecondWave: TimeInterval = 600
  public static let talkingFor: TimeInterval = 1.2
  public static let hopGap: TimeInterval = 1
  public static let grumbleClicks = 5
  public static let grumbleWindow: TimeInterval = 3
  public static let grumbleGap: TimeInterval = 60
  /// Every antic the art can have (sit, nap, stretch, scratch, stumble, tinker, review) and how long each plays: the names the sprite
  /// treats as antics. The manifest is the truth for the real art (the controller passes its own totals in `CompanionEnv.antics`);
  /// a test keeps this table honest.
  public static let shippedAntics: [String: TimeInterval] = [
    "sit": 7.02, "nap": 15.62, "stretch": 3.88, "scratch": 4.41, "stumble": 2.16, "tinker": 4.15, "review": 2.0, "idle-look": 5.0,
    "needs-beckon": 3.0, "needs-tap": 3.0,
  ]
  /// What he does between blinks while idle and awake: the gentle clips only. No nap (he sleeps only when Asleep) and no stumble.
  /// `waving` is a small hello to nobody and `review` is him looking around. The default for `CompanionEnv.antics`; a test pins the
  /// lengths to the real manifest.
  public static let idleAntics: [String: TimeInterval] = [
    "sit": 7.02, "stretch": 3.88, "scratch": 4.41, "tinker": 4.15, "review": 2.0, "waving": 1.14, "idle-look": 5.0,
  ]
  /// What he rotates through while he waits for you (Needs you): a beckon and a toe tap. Their stance is the waiting pose, so each starts
  /// and ends on his base Needs-you loop with no pop.
  public static let needsAntics: [String: TimeInterval] = ["needs-beckon": 3.0, "needs-tap": 3.0]
  /// A new clip every 3 to 10 s while he is idle and awake or waiting for you, never the one before. Counted from the start of the last
  /// one; between two clips his base loop (breathing and weight shift in Idle, the rock in Needs you) always plays for `restBreath`.
  public static let anticGap: ClosedRange<Double> = 3...10
  public static let restBreath: TimeInterval = 2
  /// The longest a walk (Rounds, 44 steps at 6 a second, or the wander) takes: nothing else starts under it.
  public static let walkSpan: TimeInterval = 8
  /// A short wander along his line and back, this often while idle and awake.
  public static let wanderGap: ClosedRange<Double> = 60...180
  /// Slower when the Mac has been left alone: the gap grows 1.5x after 5 minutes without a key or a click, 2x (the most) after 15.
  public static let anticAwayShort: TimeInterval = 300
  public static let anticAwayLong: TimeInterval = 900
  /// The sleep clip's lying-down half and the wake's getting-up half last this long each (the first and the last five cells of the
  /// `nap` clip, a test pins it to the manifest). A wake that cuts the sleep earlier than this into it plays `wake-low` (the
  /// getting-up from a seat); a later one plays `wake`, from the lying cell.
  public static let napEdge: TimeInterval = 1.41
  /// Whether the sprite view cuts this clip when the model says an antic must stop: every clip the idle pool can play.
  public static func isAntic(_ clip: String) -> Bool { shippedAntics[clip] != nil || idleAntics[clip] != nil || needsAntics[clip] != nil }
  /// No antic starts if it would still be playing this close to Asleep.
  public static let anticMargin: TimeInterval = 2
  public static let roundsGrace: TimeInterval = 90
  /// Trouble holds 10 s, then Idle with a dot while `failed > 0`.
  public static let troubleHold: TimeInterval = 10
  /// Done holds 3 s, then Idle with a dot while `unread > 0`.
  public static let doneHold: TimeInterval = 3
  /// One Done hop per minute, and one reply bubble per thread per minute (the banner tag's own limit).
  public static let doneGap: TimeInterval = 60
  /// A rising Working count plays one strike, at most every 30 s.
  public static let strikeGap: TimeInterval = 30
  /// A Working claim from the feed's counts that has not changed for this long is stale (no session activity backs it).
  public static let staleWork: TimeInterval = 900
  /// After the feed returns, failures up to the count it showed before are not new for this long.
  public static let reloadSettle: TimeInterval = 20

  private var random: (ClosedRange<Double>) -> Double
  private var inputs = CompanionInputs()
  private var env = CompanionEnv()

  private var shown: CompanionState = .idle  // never .asleep: that is derived
  private var lastChange: TimeInterval = -.infinity
  private var pending: (state: CompanionState, since: TimeInterval)?
  private var lastActivity: TimeInterval = 0
  private var forcedAsleep = false

  private var seq = 0
  private var carried: CompanionAnimation?
  private var dragging = false
  private var dragDirection = "running-right"
  private var heldBubble: (bubble: CompanionBubble, state: CompanionState)?
  private var needsWaveAt: TimeInterval?

  private var clicks: [TimeInterval] = []
  private var lastHop: TimeInterval = -.infinity
  private var lastGrumble: TimeInterval = -.infinity
  /// The next antic: the time its wait began and the gap drawn for it. It is due at `from + gap * away factor`, the factor read
  /// when asked (the Mac left alone makes it later), so no timer runs for it and a longer absence never starts one early.
  private var anticAt: (from: TimeInterval, gap: Double)?
  private var anticRun: (name: String, start: TimeInterval, until: TimeInterval)?
  /// No clip starts before this: the last one's end plus `restBreath`, so the base loop is on screen between two clips.
  private var anticFreeAt: TimeInterval = -.infinity
  /// The next wander, kept like `anticAt`: the wait began at `from` and is due at `from + gap * away factor`.
  private var wanderAt: (from: TimeInterval, gap: Double)?
  private var lastAntic: String?
  private var anticStopSeq = 0
  /// The last owner activity the antic clock has seen: any new one starts the wait over, so he never fidgets the moment you leave.
  private var anticSeenAt: TimeInterval = -.infinity
  private var wasNap = false
  private var sleepStart: TimeInterval = -.infinity
  private var talkUntil: TimeInterval = -.infinity

  private var prevQuiet: Bool?
  private var morningDay: String?
  private var morningPending = false
  private var collectedBase = 0

  private var roundsDay: String?
  private var roundsSlots: [Date] = []
  /// The wall time of the last evaluation: a wake that finds the wall clock 30 minutes or more ahead of it slept long enough
  /// to have gone to sleep. A short lid close does not.
  private var lastWall: Date?

  private var helloPending = false
  private var started = false

  // The feed half (C-LIVE). Baselines: the first frame after any page load sets them, so a reload never fires Trouble or Done.
  private var feedSeen = false
  private var baseFailed = 0
  private var baseReplySeq: Int?
  private var troubleUntil: TimeInterval?
  private var doneUntil: TimeInterval?
  /// One entry per thread: two working threads that both answer must each get their own Done.
  private var armedDone: [String: Int] = [:]
  /// A failed count the feed showed before it went away. A page reload restarts `failed` at 0 and the outbox then re-fails
  /// the same messages: rising back up to this within `reloadSettle` is the same failures again, not new ones.
  private var lostFailed = 0
  private var reloadFloor = 0
  private var reloadFloorUntil: TimeInterval = -.infinity
  /// What the feed's Working claim was made of, and since when. A `queued` or `working` row the relay never clears must not
  /// hold him in Working for ever.
  private var workSig: [String] = []
  private var workSigSince: TimeInterval = 0
  private var pendingDoneThread: String?
  private var standaloneReply: String?
  private var lastDoneHop: TimeInterval = -.infinity
  private var replyBubbleAt: [String: TimeInterval] = [:]
  private var lastStrike: TimeInterval = -.infinity
  private var prevWorkCount: Int?
  private var failedDot = false
  private var unreadDot = false
  /// Replies and failed sends that came inside the quiet window: Morning counts them with the dropped banners.
  private var collectedExtra = 0

  /// What survives a rebuild of the model (a size change, the end of a snooze, off and on): the count Morning already
  /// reported and the day's Rounds plan. Without it a rebuild would re-report items and plan more than nine Rounds a day.
  public struct Carry: Equatable, Sendable {
    public var collectedBase = 0
    public var roundsDay: String?
    public var roundsSlots: [Date] = []
    public var morningDay: String?
    public var collectedExtra = 0
    public init() {}
  }

  public var carry: Carry {
    var c = Carry()
    c.collectedBase = collectedBase
    c.roundsDay = roundsDay
    c.roundsSlots = roundsSlots
    c.morningDay = morningDay
    c.collectedExtra = collectedExtra
    return c
  }

  public init(random: @escaping (ClosedRange<Double>) -> Double = { Double.random(in: $0) }, carry: Carry = Carry()) {
    self.random = random
    collectedBase = carry.collectedBase
    roundsDay = carry.roundsDay
    roundsSlots = carry.roundsSlots
    morningDay = carry.morningDay
    collectedExtra = carry.collectedExtra
  }

  // MARK: events

  /// Every recompute: new inputs. Also the periodic tick.
  public mutating func update(_ i: CompanionInputs, env e: CompanionEnv, mono: TimeInterval, wall: Date) -> CompanionOutput {
    inputs = i
    env = e
    return evaluate(mono: mono, wall: wall, event: nil)
  }

  /// The owner turned him on: Hello.
  public mutating func turnedOn(mono: TimeInterval, wall: Date) -> CompanionOutput {
    lastActivity = mono
    forcedAsleep = false
    helloPending = true
    anticAt = nil
    anticRun = nil
    anticFreeAt = -.infinity
    return evaluate(mono: mono, wall: wall, event: nil)
  }

  /// Hover, compose or anything else that counts as the owner being there.
  public mutating func activity(mono: TimeInterval, wall: Date) -> CompanionOutput {
    lastActivity = mono
    forcedAsleep = false
    return evaluate(mono: mono, wall: wall, event: nil)
  }

  /// A click on him. Every click counts toward Grumble, whatever the clamps say.
  public mutating func click(mono: TimeInterval, wall: Date) -> CompanionOutput {
    lastActivity = mono
    forcedAsleep = false
    clicks.append(mono)
    clicks.removeAll { mono - $0 > Self.grumbleWindow }
    return evaluate(mono: mono, wall: wall, event: .click)
  }

  public mutating func dragBegan(directionRight: Bool, mono: TimeInterval, wall: Date) -> CompanionOutput {
    lastActivity = mono
    forcedAsleep = false
    dragging = true
    dragDirection = directionRight ? "running-right" : "running-left"
    return evaluate(mono: mono, wall: wall, event: .dragBegan)
  }

  public mutating func dragMoved(directionRight: Bool, mono: TimeInterval, wall: Date) -> CompanionOutput {
    let d = directionRight ? "running-right" : "running-left"
    guard dragging, d != dragDirection else { return evaluate(mono: mono, wall: wall, event: nil) }
    dragDirection = d
    return evaluate(mono: mono, wall: wall, event: .dragBegan)
  }

  public mutating func dragEnded(mono: TimeInterval, wall: Date) -> CompanionOutput {
    lastActivity = mono
    dragging = false
    carried = nil
    return evaluate(mono: mono, wall: wall, event: .dropped)
  }

  /// The Mac woke. Timers don't count sleep, so every deadline is re-armed here and nothing that came due while it slept is
  /// replayed (8 hours asleep must not give a burst of beats). He is asleep only if the sleep was 30 minutes or more (spec 2.2
  /// defines Asleep by time, and a two-minute lid close is not that).
  public mutating func woke(mono: TimeInterval, wall: Date) -> CompanionOutput {
    if let l = lastWall, wall.timeIntervalSince(l) >= Self.asleepAfter { forcedAsleep = true }
    anticAt = nil
    anticRun = nil
    anticFreeAt = -.infinity
    wanderAt = nil
    carried = nil
    dragging = false
    clicks.removeAll()
    helloPending = false
    heldBubble = nil
    armedDone = [:]
    needsWaveAt = shown == .needsYou ? mono + Self.needsSecondWave : nil
    roundsSlots.removeAll { $0 < wall }  // slots that passed during sleep are dropped, no catch-up
    pending = pending.map { ($0.state, mono) }
    return evaluate(mono: mono, wall: wall, event: .woke)
  }

  public mutating func roundsStarted(mono: TimeInterval, wall: Date) -> CompanionOutput {
    if !roundsSlots.isEmpty { roundsSlots.removeFirst() }
    lastActivity = mono
    forcedAsleep = false
    anticFreeAt = max(anticFreeAt, mono + Self.walkSpan + Self.restBreath)
    return evaluate(mono: mono, wall: wall, event: nil)
  }

  /// The controller's answer for whichever walk it was asked for (`CompanionWalkKind.requested`).
  public mutating func walkStarted(_ kind: CompanionWalkKind, mono: TimeInterval, wall: Date) -> CompanionOutput {
    kind == .wander ? wanderStarted(mono: mono, wall: wall) : roundsStarted(mono: mono, wall: wall)
  }

  public mutating func walkDeclined(_ kind: CompanionWalkKind, mono: TimeInterval, wall: Date) -> CompanionOutput {
    kind == .wander ? wanderDeclined(mono: mono, wall: wall) : roundsDeclined(mono: mono, wall: wall)
  }

  public mutating func roundsDeclined(mono: TimeInterval, wall: Date) -> CompanionOutput {
    if !roundsSlots.isEmpty { roundsSlots.removeFirst() }  // a missed slot is dropped
    return evaluate(mono: mono, wall: wall, event: nil)
  }

  /// The controller began the wander (it passed the pointer and panel checks): both waits start over, and no clip starts while he is
  /// out walking (`walkSpan`) or in the base loop's `restBreath` after. It is not owner activity: it never wakes him or delays sleep.
  public mutating func wanderStarted(mono: TimeInterval, wall: Date) -> CompanionOutput {
    wanderAt = nil
    anticAt = nil
    anticFreeAt = max(anticFreeAt, mono + Self.walkSpan + Self.restBreath)
    return evaluate(mono: mono, wall: wall, event: nil)
  }

  /// The controller could not start it (the pointer is near, something is open): a new wait is drawn.
  public mutating func wanderDeclined(mono: TimeInterval, wall: Date) -> CompanionOutput {
    wanderAt = nil
    return evaluate(mono: mono, wall: wall, event: nil)
  }

  // MARK: the reducer

  private enum Event { case click, dragBegan, dropped, woke }

  private var asleepNow: Bool { shown == .idle && (forcedAsleep || lastMono - lastActivity >= Self.asleepAfter) }
  private var lastMono: TimeInterval = 0

  private func target(mono: TimeInterval) -> CompanionState {
    if case .stopped(let byOwner) = inputs.session, !byOwner { return .down }
    if inputs.relayDown { return .down }
    if inputs.session == .blocked || inputs.sessionNeedsYou || inputs.effectiveNeeds > 0 { return .needsYou }
    if let t = troubleUntil, mono < t { return .trouble }
    if let d = doneUntil, mono < d { return .done }
    if let f = inputs.feed {
      if feedWorking(f, mono: mono) { return .working }
    } else if case .running(let busy) = inputs.session, busy {
      return .working
    }
    return .idle
  }

  /// The feed says Working only while something backs it. The owner's own stop means no agent is running, whatever a row the
  /// relay never cleared still says, and a count that has not changed for `staleWork` with no session activity is stale.
  private func feedWorking(_ f: CompanionFeed, mono: TimeInterval) -> Bool {
    if case .stopped(let byOwner) = inputs.session, byOwner { return false }
    if f.busy { return true }
    guard f.working + f.queued > 0 else { return false }
    if case .running(let busy) = inputs.session, busy { return true }
    return mono - workSigSince < Self.staleWork
  }

  /// The Needs-you bubble: the thread when the feed names one the page listed, else the agent.
  private func needsBubble() -> CompanionBubble {
    if inputs.session != .blocked, !inputs.sessionNeedsYou, let f = inputs.feed,
      let row = f.rows.first(where: { $0.state == .needsYou }), let t = inputs.threads.first(where: { $0.id == row.threadId })
    {
      return .needsYouIn(thread: t.name, id: t.id)
    }
    return .needsYou(agent: inputs.agentName)
  }

  private func threadName(_ id: String) -> String { inputs.threads.first { $0.id == id }?.name ?? "A thread" }

  /// Reads the feed: Trouble when `failed` rose, Done when `last_reply.seq` rose, a strike when the count rose. A feed that
  /// goes away clears what it drove (the holds and the pending beats) but keeps the dots: they say something is still unread
  /// or failed, and a reload or a wake must not erase that. Runs once per evaluation, before the state is chosen.
  private mutating func ingestFeed(mono: TimeInterval) {
    if let d = doneUntil, mono >= d {
      doneUntil = nil
      pendingDoneThread = nil  // a Done that never got to show (something outranked it) must not block the next one
    }
    guard let f = inputs.feed else {
      if feedSeen { lostFailed = max(lostFailed, baseFailed) }
      feedSeen = false
      troubleUntil = nil
      doneUntil = nil
      armedDone = [:]
      pendingDoneThread = nil
      standaloneReply = nil
      prevWorkCount = nil
      workSig = []
      return
    }
    let sig = f.rows.filter { $0.state == .working || $0.state == .queued }.map { "\($0.threadId):\($0.state.rawValue)" }
      + ["w\(f.working)", "q\(f.queued)"]
    if sig != workSig {
      workSig = sig
      workSigSince = mono
    }
    if !feedSeen {
      feedSeen = true
      baseFailed = f.failed
      baseReplySeq = f.lastReply?.seq
      prevWorkCount = f.working + f.queued
      if lostFailed > f.failed {
        reloadFloor = lostFailed
        reloadFloorUntil = mono + Self.reloadSettle
      }
      lostFailed = 0
      return
    }
    if f.failed == 0 { failedDot = false }
    if f.unread == 0 { unreadDot = false }
    let settling = mono < reloadFloorUntil
    if f.failed > baseFailed {
      failedDot = true
      if !(settling && f.failed <= reloadFloor) {
        if quietNow { collectedExtra += 1 }
        troubleUntil = mono + Self.troubleHold  // a second failure while he is already in Trouble only extends it
      }
    }
    baseFailed = f.failed
    if let lr = f.lastReply, lr.seq > (baseReplySeq ?? -1) {
      baseReplySeq = lr.seq
      // It waits for a working thread to finish (one hop per turn). A reply the owner is looking at is not news: the check
      // below drops it while the Talos window is key.
      armedDone[lr.threadId] = lr.seq
    } else if let lr = f.lastReply {
      baseReplySeq = max(baseReplySeq ?? lr.seq, lr.seq)
    }
    for thread in armedDone.keys.sorted() {
      if inputs.windowIsKey {
        armedDone[thread] = nil
      } else if !f.rows.contains(where: { $0.threadId == thread && $0.state == .working }) {
        // One beat at a time: a second thread that finished in the same pass keeps its place until the first is shown.
        if pendingDoneThread != nil || standaloneReply != nil { break }
        armedDone[thread] = nil
        fireDone(thread: thread, mono: mono)
      }
    }
  }

  private mutating func fireDone(thread: String, mono: TimeInterval) {
    unreadDot = true
    if quietNow { collectedExtra += 1 }
    let bubbleOK = mono - (replyBubbleAt[thread] ?? -.infinity) >= Self.doneGap
    if bubbleOK { replyBubbleAt[thread] = mono }
    if mono - lastDoneHop >= Self.doneGap {
      lastDoneHop = mono
      doneUntil = mono + Self.doneHold
      pendingDoneThread = bubbleOK ? thread : nil
    } else if bubbleOK {
      standaloneReply = thread  // inside a hop's minute: the bubble alone
    }
  }


  private var quietNow: Bool { inputs.quiet == true }
  private var decisionsKnown: Bool { inputs.quiet != nil }
  private var bubbleGate: Bool { decisionsKnown && !quietNow && !env.micRunning }

  /// Beats and moves are not held back by the quiet window, only by an unknown decision (nothing before the first bridge read), a
  /// running mic and the motion clamps.
  private func beatGate(asleep: Bool) -> Bool {
    decisionsKnown && !env.micRunning && !asleep && !env.reduceMotion && !env.lowPower && !env.mini
  }

  private mutating func nextSeq() -> Int {
    seq += 1
    return seq
  }

  /// The factor on an antic's gap for a Mac nobody has touched for `seconds`.
  static func awayFactor(_ seconds: Double) -> Double {
    seconds >= anticAwayLong ? 2.0 : (seconds >= anticAwayShort ? 1.5 : 1.0)
  }

  /// A random antic from what the art has, never the one just played (unless it is the only one). Sorted first, so the same dice
  /// give the same pick.
  private mutating func pickAntic(from pool: [String: TimeInterval]) -> (name: String, seconds: TimeInterval)? {
    let all = pool.keys.sorted()
    var names = all.filter { $0 != lastAntic }
    if names.isEmpty { names = all }
    guard !names.isEmpty else { return nil }
    let k = min(names.count - 1, max(0, Int(random(0...Double(names.count)))))
    return (names[k], pool[names[k]] ?? 0)
  }

  private mutating func evaluate(mono: TimeInterval, wall: Date, event: Event?) -> CompanionOutput {
    lastMono = mono
    defer { lastWall = wall }
    if !started {
      started = true
      lastActivity = mono
      morningDay = Self.dayKey(wall, window: inputs.quietWindow)  // turning on is the day's first greeting (Hello)
    }
    var anim: CompanionAnimation?
    var entry = false

    ingestFeed(mono: mono)

    // 1. State, with hysteresis.
    let raw = target(mono: mono)
    if raw == shown {
      pending = nil
    } else {
      if pending?.state != raw { pending = (raw, mono) }
      let rising = raw.priority > shown.priority
      var at = pending!.since
      if raw == .working && shown == .idle { at += Self.enterWorking }
      if shown == .working && raw == .idle { at += Self.leaveWorking }
      if !rising { at = max(at, lastChange + Self.minChange) }
      if mono >= at {
        shown = raw
        lastChange = mono
        lastActivity = mono
        forcedAsleep = false
        pending = nil
        entry = true
        heldBubble = nil
        needsWaveAt = raw == .needsYou ? mono + Self.needsSecondWave : nil
        anticAt = nil
        anticRun = nil
        anticFreeAt = -.infinity
        carried = nil
      }
    }
    // 2. Entry: the animation and the bubble for the state he just entered.
    if entry {
      switch shown {
      case .down:
        anim = CompanionAnimation(clip: "failed", seq: nextSeq())
        if case .stopped(let byOwner) = inputs.session, !byOwner {
          heldBubble = (.sessionStopped(agent: inputs.agentName), .down)
        }
      case .needsYou:
        anim = CompanionAnimation(clip: "waving", seq: nextSeq())
        heldBubble = (needsBubble(), .needsYou)
      case .working:
        anim = CompanionAnimation(clip: "running", repeatFor: Self.workingRun, seq: nextSeq())
      case .trouble:
        anim = CompanionAnimation(clip: "failed", seq: nextSeq())
        heldBubble = (.sendFailed, .trouble)
      case .done:
        anim = CompanionAnimation(clip: "jumping", seq: nextSeq())
        if let t = pendingDoneThread { heldBubble = (.newReply(thread: threadName(t), id: t), .done) }
        pendingDoneThread = nil
      case .idle, .asleep:
        break
      }
    }

    // 3. Morning: quiet just ended, or the Mac woke on a new day.
    let day = Self.dayKey(wall, window: inputs.quietWindow)
    if let q = inputs.quiet {
      if prevQuiet == true && q == false { morningPending = true; lastActivity = mono; forcedAsleep = false }
      if event == .woke && !q && morningDay != day { morningPending = true }
      prevQuiet = q
    }
    var morningBubble: CompanionBubble?
    if morningPending, morningDay != day, bubbleGate {
      morningPending = false
      morningDay = day
      lastActivity = mono
      forcedAsleep = false
      if anim == nil && !env.reduceMotion && !env.lowPower && !env.mini { anim = CompanionAnimation(clip: "waving", seq: nextSeq()) }
      let n = inputs.collected - collectedBase + collectedExtra
      collectedBase = inputs.collected
      collectedExtra = 0
      if n > 0 { morningBubble = .overnight(items: n) }
    } else if morningPending, morningDay == day {
      morningPending = false
    }

    // 4. Hello.
    let gate = beatGate(asleep: asleepNow)
    if helloPending {
      if decisionsKnown {
        helloPending = false
        if gate && anim == nil { anim = CompanionAnimation(clip: "waving", seq: nextSeq()) }
      }
    }

    // 5. Needs you: one more wave at 10 minutes, then nothing.
    if shown == .needsYou, let w = needsWaveAt, mono >= w {
      needsWaveAt = nil
      if gate && anim == nil { anim = CompanionAnimation(clip: "waving", seq: nextSeq()) }
    }

    // 6. Click: Poke, Grumble, or the alert's bubble again.
    if event == .click {
      let alert = shown == .down || shown == .needsYou || shown == .trouble
      if clicks.count >= Self.grumbleClicks && mono - lastGrumble >= Self.grumbleGap {
        clicks.removeAll()
        if beatGate(asleep: false) {
          lastGrumble = mono
          anim = CompanionAnimation(clip: "running", seq: nextSeq())
        }
      } else if alert {
        switch shown {
        case .down:
          if case .stopped(let byOwner) = inputs.session, !byOwner { heldBubble = (.sessionStopped(agent: inputs.agentName), .down) }
        case .trouble: heldBubble = (.sendFailed, .trouble)
        default: heldBubble = (needsBubble(), .needsYou)
        }
      } else if beatGate(asleep: false), mono - lastHop >= Self.hopGap {
        lastHop = mono
        anim = CompanionAnimation(clip: "jumping", frameLimit: 4, seq: nextSeq())
      }
    }

    // 7. Carried and Landed.
    if dragging {
      if event == .dragBegan || carried == nil {
        carried = CompanionAnimation(clip: dragDirection, untilCleared: true, seq: nextSeq())
      }
      if beatGate(asleep: false) { anim = carried } else { anim = nil }
    } else if event == .dropped, beatGate(asleep: false) {
      anim = CompanionAnimation(clip: "landed", seq: nextSeq())
    }

    // 8. Rotating clips: a new little thing every 3 to 10 s while he is idle and awake (an antic or the look around) or waiting for you
    // (a beckon, a toe tap). One at a time, never the one before, with his base loop playing between two. Slower when the Mac has been
    // left alone. Other states, clamps and any sign of the owner cut one that is playing.
    let awakeIdle = shown == .idle && !asleepNow
    let lifeOK = awakeIdle && env.moments && beatGate(asleep: false)  // what Rounds and wanders need
    let waiting = shown == .needsYou
    let restPool = waiting ? env.needsClips : env.antics
    let anticsOK = (lifeOK || (waiting && env.moments && beatGate(asleep: false))) && !restPool.isEmpty
    var anticCut = false
    if let r = anticRun {
      if mono >= r.until {
        anticRun = nil
      } else if !anticsOK || restPool[r.name] == nil || lastActivity > r.start || dragging || env.anticHold {
        anticRun = nil
        anticCut = true
        anticFreeAt = mono  // cut: the base loop is on screen again now, nothing holds the next clip back but its own gap
      }
    }
    if lastActivity > anticSeenAt {
      anticSeenAt = lastActivity
      anticAt = nil
      wanderAt = nil
    }
    if anticsOK {
      if anticAt == nil { anticAt = (mono, random(Self.anticGap)) }
      if let a = anticAt, anticRun == nil, anim == nil, !dragging, !env.bubbleOpen, !env.anticHold, mono >= talkUntil, mono >= anticFreeAt,
        mono >= a.from + a.gap * Self.awayFactor(env.secondsSinceInput),
        let pick = pickAntic(from: restPool), waiting || mono + pick.seconds + Self.anticMargin <= lastActivity + Self.asleepAfter
      {
        anim = CompanionAnimation(clip: pick.name, seq: nextSeq())
        anticRun = (pick.name, mono, mono + pick.seconds)
        lastAntic = pick.name
        anticAt = (mono, random(Self.anticGap))
        anticFreeAt = mono + pick.seconds + Self.restBreath
      }
    } else if !awakeIdle && !waiting {
      anticAt = nil
    }
    if anticCut && anim == nil { anticStopSeq += 1 }

    // 8b. Working: a rising count plays one strike, at most every 30 s.
    let work = inputs.workCount
    if inputs.feed != nil {
      if shown == .working, let p = prevWorkCount, work > p, anim == nil, !dragging, beatGate(asleep: false),
        mono - lastStrike >= Self.strikeGap
      {
        lastStrike = mono
        anim = CompanionAnimation(clip: "running", seq: nextSeq())
      }
      prevWorkCount = work
    }

    // 9. Rounds slots for today, and whether one is due now.
    if roundsDay != day {
      roundsDay = day
      roundsSlots = decisionsKnown ? RoundsPlan.slots(on: wall, quiet: inputs.quietWindow, random: random) : []
      if !decisionsKnown { roundsDay = nil }
    }
    roundsSlots.removeAll { wall.timeIntervalSince($0) > Self.roundsGrace }  // missed: dropped
    let wakeOK = !asleepNow || env.secondsSinceInput <= 60
    let roundsDue =
      (shown == .idle || shown == .working) && !dragging && env.moments && decisionsKnown && !env.micRunning && !env.reduceMotion && !env.lowPower
      && !env.mini && wakeOK && (roundsSlots.first.map { $0 <= wall } ?? false)

    // 10. Bubbles. A held bubble shows once the clamps allow it, and only while it is still true.
    if let h = heldBubble, h.state != shown { heldBubble = nil }
    var event2: CompanionBubbleEvent?
    if let m = morningBubble, bubbleGate {
      event2 = CompanionBubbleEvent(bubble: m, seq: nextSeq())
    } else if let h = heldBubble, bubbleGate, !dragging {
      event2 = CompanionBubbleEvent(bubble: h.bubble, seq: nextSeq())
      heldBubble = nil
    } else if let t = standaloneReply, bubbleGate, !dragging {
      event2 = CompanionBubbleEvent(bubble: .newReply(thread: threadName(t), id: t), seq: nextSeq())
    }
    standaloneReply = nil  // a bubble the clamps hold back for a reply that is not a state is dropped, not queued
    if event2 != nil, anim == nil, beatGate(asleep: asleepNow) {
      anticRun = nil  // the talking clip replaces an antic on screen; a stale run would wake him from standing on the next hover
      anim = CompanionAnimation(clip: "talking", repeatFor: Self.talkingFor, seq: nextSeq())
      talkUntil = mono + Self.talkingFor
    }
    // Dozing off and waking up are walked, not popped: he lies down into the nap pose and gets up out of it. A wake from a Mac
    // that slept (the lid) just shows the nap. A state's own entry animation, a click or a drop win.
    let napNow = asleepNow
    if napNow, !wasNap, event != .woke, anim == nil, !dragging, beatGate(asleep: false) {
      anim = CompanionAnimation(clip: "sleep", seq: nextSeq())
      sleepStart = mono
    } else if wasNap, !napNow, anim == nil, !dragging, beatGate(asleep: false) {
      // Woken while still lying down (the first part of the sleep clip): get up from the seat, not from the floor.
      anim = CompanionAnimation(clip: mono - sleepStart < Self.napEdge ? "wake-low" : "wake", seq: nextSeq())
    }
    wasNap = napNow
    if env.reduceMotion || env.lowPower { anim = nil }  // every state shows its still; bubbles stay

    // 10b. A short wander every 1 to 3 minutes: due once everything he could be doing instead is over. The controller checks the
    // pointer and the open panels, then answers with `wanderStarted` or `wanderDeclined`.
    var wanderDue = false
    if lifeOK {
      if wanderAt == nil { wanderAt = (mono, random(Self.wanderGap)) }
      if let w = wanderAt, anticRun == nil, anim == nil, event2 == nil, !dragging, !env.bubbleOpen, !env.anticHold, mono >= talkUntil,
        mono >= w.from + w.gap * Self.awayFactor(env.secondsSinceInput)
      {
        wanderDue = true
      }
    } else {
      wanderAt = nil
    }

    // 11. The picture.
    let sleeping = asleepNow
    let rest: CompanionRest
    if sleeping {
      rest = .nap
    } else {
      switch shown {
      case .idle, .asleep: rest = .idle
      case .down, .trouble: rest = .holdLast("failed")
      case .done: rest = .holdLast("jumping")
      case .needsYou: rest = .holdStill("waiting")
      case .working: rest = .holdLast("running")
      }
    }

    let outState: CompanionState = sleeping ? .asleep : shown
    let word = CompanionPhrase.word(
      outState, session: inputs.session, relayDown: inputs.relayDown, needs: inputs.effectiveNeeds, count: inputs.workCount)
    var dot = quietNow && inputs.collected - collectedBase + collectedExtra > 0
    if !quietNow, shown == .idle, let f = inputs.feed, (failedDot && f.failed > 0) || (unreadDot && f.unread > 0) { dot = true }

    return CompanionOutput(
      state: outState, quiet: quietNow, animation: anim, rest: rest,
      bubble: event2, word: word, accessibilityLabel: CompanionPhrase.accessibility(agent: inputs.agentName, word: word),
      dot: dot, dragging: dragging, roundsDue: roundsDue, wanderDue: wanderDue, anticStop: anticStopSeq,
      nextDeadline: deadline(mono: mono, wall: wall))
  }

  /// The next moment the reducer must be asked again. Only future moments count: a due thing that a clamp is holding back
  /// (a Rounds slot with the owner away, an idle antic with the mic on) is re-checked by the periodic recompute and by the event
  /// that lifts the clamp, never by asking every 50 ms (spec 3.2, no polling).
  private func deadline(mono: TimeInterval, wall: Date) -> TimeInterval? {
    var d: [TimeInterval] = []
    if let p = pending {
      var at = p.since
      if p.state == .working && shown == .idle { at += Self.enterWorking }
      if shown == .working && p.state == .idle { at += Self.leaveWorking }
      if p.state.priority < shown.priority { at = max(at, lastChange + Self.minChange) }
      d.append(at)
    }
    if shown == .idle && !asleepNow && !forcedAsleep { d.append(lastActivity + Self.asleepAfter) }
    if let a = anticAt, shown == .idle || shown == .needsYou, anticRun == nil { d.append(max(a.from + a.gap * Self.awayFactor(env.secondsSinceInput), anticFreeAt)) }
    // A clip on screen: its own end is the next instant (the next rotation is timed from there), never the 2 s poll.
    if let r = anticRun { d.append(r.until) }
    if let w = wanderAt, shown == .idle { d.append(w.from + w.gap * Self.awayFactor(env.secondsSinceInput)) }
    if shown == .needsYou, let w = needsWaveAt { d.append(w) }
    if let s = roundsSlots.first { d.append(mono + s.timeIntervalSince(wall)) }
    if let t = troubleUntil { d.append(t) }
    if let t = doneUntil { d.append(t) }
    if let f = inputs.feed, !f.busy, f.working + f.queued > 0 { d.append(workSigSince + Self.staleWork) }
    return d.filter { $0 > mono }.min()
  }

  /// A local calendar day in the quiet window's zone (or the Mac's own), as text.
  static func dayKey(_ d: Date, window: QuietWindow?) -> String {
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = window?.timeZone ?? .current
    let c = cal.dateComponents([.year, .month, .day], from: d)
    return "\(c.year ?? 0)-\(c.month ?? 0)-\(c.day ?? 0)"
  }
}

/// Nine Rounds slots a day (the owner's 2026-11-06 ask: three was too few), spread over the whole 24 hours with no quiet-window
/// exclusion. The day is cut into nine equal parts of 160 minutes and each slot lands inside the middle of its part (20 to 139
/// minutes in), so two slots are never closer than 41 minutes. The quiet window only supplies the time zone the day is cut in.
/// Times are set by local clock reading, so a 23- or 25-hour DST day still holds all nine on that day. Spec 2.4.
public enum RoundsPlan {
  public static let perDay = 9
  public static let minimumGapMinutes = 40

  public static func slots(on day: Date, quiet: QuietWindow?, random: (ClosedRange<Double>) -> Double) -> [Date] {
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = quiet?.timeZone ?? .current
    let start = cal.startOfDay(for: day)
    let part = 1440 / perDay
    var out: [Date] = []
    for k in 0..<perDay {
      let lo = Double(part * k + 20)
      let hi = Double(part * (k + 1) - 21)
      let m = min(1439, Int(random(lo...hi)))
      if let d = cal.date(bySettingHour: m / 60, minute: m % 60, second: 0, of: start) { out.append(d) }
    }
    return out
  }
}

/// Double-click opens Talos only after `NSEvent.doubleClickInterval` with no third click: five fast clicks are clickCount
/// 1 to 5, and without the wait Grumble would open the app (spec 3.3).
public struct ClickGate: Equatable, Sendable {
  private var openAt: TimeInterval?
  public init() {}

  /// Register a click with its `clickCount`. Returns the time to ask `due` again, or nil.
  public mutating func click(count: Int, mono: TimeInterval, interval: TimeInterval) -> TimeInterval? {
    openAt = count == 2 ? mono + interval : nil
    return openAt
  }

  /// True once, when the wait has run out with no further click.
  public mutating func due(mono: TimeInterval) -> Bool {
    guard let t = openAt, mono >= t else { return false }
    openAt = nil
    return true
  }

  public mutating func cancel() { openAt = nil }
}
