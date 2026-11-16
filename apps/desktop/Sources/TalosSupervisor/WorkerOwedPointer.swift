import Foundation
import TalosDesktopCore

/// Option C: a pointer a thread's session is owed survives the app going away (docs/OPTION-C.md "Known gaps"). The hub gives a message
/// to main when no `read_inbound` claims it within its deadline (`CLAIM_DEADLINE_MS`, or `_COLD_MS` when the wake had to start the
/// worker), and the supervisor takes the wake before it can type the line, so a Quit, a crash or an update relaunch in between lost
/// the line and left the thread idle. The pointer and its Enter are now in `workers.json`: `pointer_owed_until` is that deadline,
/// counted from when the hub wrote the wake or the Mac took it, whichever was first (the same constants, in `PointerTyper`), and `enter_owed` says the line is in Claude's input
/// box without its Enter. A copy that comes back (`restoreOwed`) types what is still wanted, once, and drops what is not.
///
/// The deadline rule, not the hub's own claim table: the claims are rows in the bridge's `history.sqlite`, whose schema and locking are
/// the bridge's, and the wake file carries message ids the Mac never reads. Past the deadline the hub has given the message to main
/// (or will, within the tick that separates its clock from ours), and read_inbound's claim is atomic, so nothing is delivered twice
/// either way; this only keeps the session from being woken for a message main already has.
///
/// The box tells the truth about the Enter: our own line, exactly and at normal intensity, in the box is ours (never an owner's draft,
/// whether or not the flag survived); anything more than it is the owner's. An Enter is sent ONLY onto that: on one capture, with its
/// colours, taken right before the send, the box holds exactly our line (`boxHoldsOnlyOurLine`; a read that fails sends nothing). An
/// empty box after our line was SEEN in it means the owner cleared it, and the whole line is typed again; a line typed and, `screenLag`
/// later, never seen in the box went somewhere else (a menu that kept the focus with an empty box drawn under it, or keys lost) and is
/// never typed a second time on top: it is held and the thread told once (`WorkerNotice.unseenKind`). The box decides, not whether a
/// draft hold was running or an earlier look was taken (only `unseenSince` says the screen may not have caught up yet), so a frame caught mid-redraw cannot turn the Enter into a keystroke on nothing (Claude drops it, the pointer is marked
/// done, and the message goes to main). A line past its deadline is taken out of the box with
/// Backspace, once per tick and at most three times, and only when the box holds exactly that line AND no tmux client is attached
/// (nobody can type into a pane without one, so a Backspace can only delete our own characters). Text that may be the owner's, or any
/// line while a client is attached, is never cleared, and the thread is told (`leftoverLine`).
///
/// Copy mode: a pane the owner scrolled back takes every key as a command of the mode, not as typing. Letters would run whatever
/// they are bound to, an Enter would only leave the mode (and the line would be counted as delivered), a Backspace would move the
/// mode's cursor (and be counted as a round of clearing). So nothing is typed, entered or cleared unless tmux says the pane is in no
/// mode: it is asked at the start of a tick (`inCopyMode`; an answer that cannot be read is not "no mode"), and every send is itself
/// conditional on the mode inside ONE tmux invocation (`sendUnlessInMode`), so a scroll between a check and a send has nowhere to
/// land. What is owed stays owed and goes in once the mode is left, if it is still wanted: a pointer the mode held back has its claim
/// deadline checked from then on like one read back from the file (`deadlined`), so a line for a message main already has is dropped
/// (or taken out of the box), never typed late. The hold is not silent: once the pointer is past its deadline, or after
/// `draftNoticeAfter`, the thread gets one line per hold and shows as Needs you (`noteCopyModeHold`). The bridge's port has the
/// first rule (apps/bridge/src/supervisor/owed-pointer.ts).

/// An Enter check under way (`scheduleEnterCheck`): the classes read so far and the pointer's deadline, to hold it by if flagged.
struct EnterCheckReads {
  var pre: EnterDetection.Class
  var after: EnterDetection.Class
  var later: EnterDetection.Class? = nil
  var latest: EnterDetection.Class? = nil
  var until: Double?
}

/// The part of a worker's runtime that is only about the owed pointer. Reset whenever nothing is owed (`Runtime.pendingPointer`).
struct OwedState {
  /// The claim deadline (wall clock) of the oldest wake this pointer answers.
  var until: Double?
  /// Read from `workers.json` by this copy and not yet typed or dropped: its deadline is checked up to the moment it is typed.
  var restored = false
  /// A start for a restored pointer on a sleeping worker has been asked for.
  var revived = false
  /// When our line was typed (awake clock), until a look at the box has shown text in it: the screen may not have caught up yet, so
  /// an empty box is not "gone" (the line would be typed twice, read as the owner's draft and held), and past `screenLag` the line is
  /// held as never seen, not typed again. nil: seen, or typed by an earlier copy of the app, whose first look at the box counts as the
  /// screen having caught up.
  var unseenSince: Double?
  /// Held back by copy mode at some point: its deadline counts from then on as a restored pointer's does, so it is never typed late.
  var deadlined = false
  /// Past its deadline, and the box holds something that may include our line: held, not cleared.
  var leftover = false
  /// Backspace rounds sent to clear our own line; three that did not clear it leave it alone.
  var clears = 0
  /// Its Enter went and may have answered a prompt that opened as it went (`EnterDetection`): held, never entered again, dropped at its
  /// claim deadline with no second line.
  var enterUncertain = false
}

extension WorkerManager.Runtime {
  /// The entry as `workers.json` has it: what is owed, from the flags the loop already keeps. The fields are written when set and
  /// left out when not, so the file of a thread owing nothing is the file of every earlier build.
  var persisted: WorkersFile.Entry {
    var e = entry
    e.pointer_owed_until = pendingPointer ? owed.until.map(ISOTime.string) : nil
    e.enter_owed = pendingPointer && enterOwed ? true : nil
    e.enter_uncertain = pendingPointer && owed.enterUncertain ? true : nil
    if !WorkerManager.offerStates.contains(entry.state) { e.dialog = nil }  // no pane, no dialog on it
    e.last_active_at = savedActivity
    if entry.state != "stopping" { e.stopping_since = nil }
    // only while there is a pane: a dialog is a screen, and a parked session has none
    e.needs_you =
      WorkerManager.offerStates.contains(entry.state)
      ? needsYouPrompt.flatMap { p in
        needsYouAt.map { .init(kind: p, since: $0, resets_at: p == UsageLimitScreen.kind ? needsYouResetsAt : nil) }
      } : nil
    return e
  }

  /// A pointer is owed until the hub's deadline, counted from the wake: when it was taken, or when the hub wrote it if that was
  /// earlier (a wake file that waited for the app). Without a wake (`wakeAt` nil: a park finished, a crash, a restart) a pointer already
  /// owed keeps its deadline, so the deadline is never later than the hub's; a newer wake can move it out, since that message has a later one.
  mutating func owePointer(cold: Bool, now t: Double, wakeAt: Double?) {
    let until = min(t, wakeAt ?? t) + (cold ? PointerTyper.claimDeadlineCold : PointerTyper.claimDeadline)
    guard pendingPointer else {
      owed = OwedState(until: until)
      pendingPointer = true
      return
    }
    // a new message after an Enter that may have answered a prompt: a fresh pointer, typed and entered as any is. One flagged Enter never
    // holds the messages after it. A pointer kept across a relaunch (no wake) keeps its hold. The hold's notice slot clears silently, so a
    // later flag gets its own line (the Linux supervisor's `owe`).
    if owed.enterUncertain, wakeAt != nil {
      owed = OwedState(until: until)
      enterOwed = false
      enterHold.reset()
      return
    }
    if wakeAt != nil, until > (owed.until ?? 0) {
      owed.until = until
      owed.leftover = false
    }
  }

  /// This copy has read the thread from `workers.json`: what was owed is owed again, until `typeOwedPointer` or `reviveOwed` settles it.
  mutating func restoreOwed() {
    guard let s = entry.pointer_owed_until else { return }
    pendingPointer = true
    enterOwed = entry.enter_owed == true
    owed = OwedState(until: ISOTime.parse(s) ?? 0, restored: true)  // a time we cannot read is a deadline long past
    owed.enterUncertain = entry.enter_uncertain == true  // still held: never entered again after a relaunch either
    entry.pointer_owed_until = nil
    entry.enter_owed = nil
    entry.enter_uncertain = nil
  }
}

extension WorkerManager {
  /// A restored pointer for a worker that has no pane to look at yet: asleep (start it, if the message is still wanted), on its way
  /// out (the park will start it), failed (nothing to type to). Past its deadline it is dropped. A worker with a pane is settled by
  /// `typeOwedPointer`, which has the screen.
  func reviveOwed(settings: DedicatedSettings, now t: Double) {
    for (id, r) in rt where r.owed.restored && !r.adoptPending && !Self.hasPane.contains(r.entry.state) {
      let state = r.entry.state
      guard t <= (r.owed.until ?? 0), let s = settings.threads[id], state != "failed" else { dropOwed(id); continue }
      if r.owed.enterUncertain { continue }  // held: nothing will be typed, so nothing is started for it; dropped at its deadline
      // still restored after the start: the deadline is checked again when the line is about to be typed
      if state == "off" || state == "parked", !r.owed.revived {
        rt[id]?.owed.revived = true
        requestStart(id, s, resume: r.entry.session_id != nil, settings, t)
      }
    }
  }

  /// A wake was taken for this thread: the pointer is owed. The wake file is already gone, so the file that says so is written now,
  /// not at the end of the tick (the start, the hold and the cap come first), when it changed.
  func oweFromWake(_ id: String, cold: Bool, now t: Double, wakeAt: Double?) {
    let before = rt[id]?.persisted.pointer_owed_until
    let wasHeld = rt[id]?.pendingPointer == true && rt[id]?.owed.enterUncertain == true
    rt[id]?.owePointer(cold: cold, now: t, wakeAt: wakeAt)
    // a fresh pointer after a held one: its line's record goes too, so a later flag is said again
    if wasHeld, rt[id]?.owed.enterUncertain != true {
      forgetNoticeRecord(id, kind: WorkerNotice.enterUncertainKind)
      rt[id]?.enterCheckToken &+= 1  // a check still under way for the old Enter holds nothing now
      dirty = true
    }
    if rt[id]?.persisted.pointer_owed_until != before { writeFile() }
  }

  private static let hasPane: Set<String> = ["starting", "live", "busy"]

  /// How long after typing (awake clock) an empty box is still read as a screen that has not caught up. Claude draws a typed line
  /// within a frame; past this the line went somewhere else, or is only buffered: it is held as never seen, never typed again.
  static let screenLag: Double = 5
  private static let looksAfterTyping = 10

  func dropOwed(_ id: String) {
    rt[id]?.enterHold.reset()
    rt[id]?.pendingPointer = false
    rt[id]?.enterOwed = false
    rt[id]?.owed = OwedState()
    noteHeldPointer(id, .none)
    dirty = true
  }

  /// One tick for a pointer waiting on a worker whose pane was read: type it, or finish its Enter, when the typing guard allows. True
  /// when the tick is used up (the caller does no idle check). `rows` is the screen, `scr` what it shows by words.
  func typeOwedPointer(_ id: String, rows: [String], screen scr: DialogMatcher.Screen, now t: Double) -> Bool {
    guard let r = rt[id] else { return false }
    // an Enter that may have answered a prompt: never a second one. Held, and at the claim deadline dropped the held way (the thread was
    // told once when it was flagged)
    let heldLate = r.owed.enterUncertain && t > (r.owed.until ?? 0)
    if r.owed.enterUncertain {
      noteHeldPointer(id, .enterUncertain)
      // the one line, until it went (a post that failed is tried again on a later tick; one that went is never sent twice)
      sendNotice(id, \.enterHold, kind: WorkerNotice.enterUncertainKind, text: WorkerNotice.enterUncertainLine())
      // before its deadline: held. After it: settled as a late pointer is (below, `settleLate`: our own line taken out of the box, or
      // left and said), never entered
      if !heldLate { return true }
    }
    // the typing guard, like the screen: unread is not "nobody is typing"
    let clients = run(tmux(id).listClientsActivity())
    guard clients.ok, let activity = TmuxCommands.parseClientActivity(clients.out) else { return true }
    // in copy mode nothing sent is typing; a mode that cannot be read is not "no mode". Nothing is settled or dropped either: the
    // pointer waits, its deadline now counts, and the thread is told once (a mode that cannot be read says nothing).
    let mode = inCopyMode(id)
    guard mode == false else {
      if mode == true {
        rt[id]?.owed.deadlined = true
        noteCopyModeHold(id, held: true, late: t > (r.owed.until ?? 0))
      }
      return true
    }
    noteCopyModeHold(id, held: false)
    let box = PointerTyper.inputBox(rows: rows) != nil
    // Text in the box (at normal intensity: a dim placeholder or suggestion is not text). Our own line, exactly, is ours whether or
    // not the flag says so (the app can go between the text and its flag), and is never an owner's draft. Anything else is the
    // owner's: more than our line included.
    let typed = draftPresent(id, rows)
    let ours = typed && PointerTyper.boxText(rows: rows) == PointerTyper.text
    let draft = typed && !ours
    let shape = scr == .none ? guardShape(rows) : scr
    // The box is on the screen and holds nothing after our text was SEEN in it (`unseenSince` nil): the owner held us off and cleared it,
    // or cleared it while the app was away (an Enter would go into an empty box and the message would be lost), so it is typed again.
    let unseen = r.owed.unseenSince
    if r.enterOwed, box, !typed, unseen == nil { rt[id]?.enterOwed = false }
    if typed { rt[id]?.owed.unseenSince = nil }
    // Typed, and `screenLag` later still never seen in the box: it went somewhere else (a menu that kept the focus with an empty box drawn
    // under it, or keys lost). Never typed a second time on top: held, and the thread is told once (the Linux typer's Fable R5-1).
    let neverSeen = r.enterOwed && !typed && (unseen.map { awake() - $0 > Self.screenLag } ?? false)
    if ours { rt[id]?.enterOwed = true }
    // a pointer from an earlier copy of the app, or one copy mode held back, is never typed past its deadline, however long it was
    // held back since
    if r.owed.restored || r.owed.deadlined || heldLate, t > (r.owed.until ?? 0) {
      let mayAct = PointerTyper.mayType(screen: shape, lastClientActivity: nil, now: t, draftPresent: false, boxVisible: box)
      return settleLate(id, r, ours: ours, draft: draft, box: box, mayAct: mayAct, attached: !activity.isEmpty)
    }
    // an owed Enter with no box on the pane is held too; a key the guard refused holds it as `refused`, a line typed and never seen as
    // `unseen` (each said, never silent)
    var hold: PointerHold = neverSeen ? .unseen : draft ? .draft : box ? .none : .noBox
    defer { noteHeldPointer(id, hold) }
    if neverSeen {
      // past the claim deadline the hub has given the message to main: dropped, and said now if the hold's wait has not said it yet
      // (the Linux typer's drop of an unseen pointer). Nothing is in the box to take out.
      guard t > (r.owed.until ?? 0) else { return true }
      sendNotice(id, \.unseenHold.notice, kind: WorkerNotice.unseenKind, text: WorkerNotice.unseenLine())
      hold = .none
      dropOwed(id)
      return false
    }
    guard PointerTyper.mayType(screen: shape, lastClientActivity: activity.max(), now: t, draftPresent: draft, boxVisible: box) else {
      return false
    }
    var justTyped = false
    if rt[id]?.enterOwed != true {
      let typedLine = sendUnlessInMode(tmux(id).sendLiteralUnlessInMode(PointerTyper.text), id: id, intent: .box(.empty))
      if typedLine == .refused { hold = .refused }
      guard typedLine == .sent else { return true }
      rt[id]?.enterOwed = true
      rt[id]?.owed.unseenSince = awake()
      justTyped = true
      writeFile()  // the text is in the box: a relaunch from here on must know it is ours
    }
    // Right after our own typing the screen may not show the text yet, so it is looked for a moment (Claude draws a typed line within a
    // frame: ten looks with nine 30 ms pauses, about 0.27 s, are plenty); if it still is not there the Enter waits for a later tick, and the empty box is not read as
    // "gone" until the line has been seen (`unseenSince`). Never an Enter on a look that does not show exactly our line.
    guard boxHoldsOnlyOurLine(id, looks: justTyped ? Self.looksAfterTyping : 1) else { return true }
    // The looks took time, and the owner may have scrolled back meanwhile: an Enter then would leave the mode and count as delivered,
    // so the Enter is sent only if the pane is in no mode, in the same tmux invocation. One whose send timed out may have landed:
    // counted as sent, never followed by a second copy of the line.
    let (enter, seen) = sendUnlessInModeReading(tmux(id).sendEnterUnlessInMode(), id: id, intent: .box(.ours))
    if enter == .refused { hold = .refused }
    guard enter == .sent || enter == .timedOut else { return true }
    // the guard read the pane right before the Enter, but a select can open in the moment between (docs/SECURITY.md): the pane is read
    // again (`scheduleEnterCheck`). Flagged: the pointer is owed again, held, and never entered a second time. Only an Enter known to be
    // sent: one whose send timed out may not have gone, and is counted as sent as before (never a second). The later reads are
    // scheduled on this queue, never slept for: a sleep here would hold every thread's tick
    if enter == .sent { scheduleEnterCheck(id, pre: seen, until: r.owed.until) }
    rt[id]?.enterOwed = false
    rt[id]?.pendingPointer = false
    hold = .none
    rt[id]?.markActive(wall: t, awake: awake())  // a pointer is activity
    rt[id]?.entry.turn_started_at = ISOTime.string(t)  // `last_turn_at` moves when this turn ends (`noteTurnEnded`)
    let typedInto = rt[id]?.entry.session_id
    rt[id]?.entry.turn_session = typedInto  // this conversation has had a turn (`Entry.hadTurn`)
    dirty = true
    emit(.pointer(thread: id))
    return true
  }

  /// A restored pointer whose deadline passed while the app was away: the hub has given the message to main, so nothing is typed.
  /// Our own line alone in the box is taken out (the owner's box is theirs again); text that may include it is left alone and the
  /// thread is told; a pointer that never reached the box is just dropped.
  private func settleLate(
    _ id: String, _ r: WorkerManager.Runtime, ours: Bool, draft: Bool, box: Bool, mayAct: Bool, attached: Bool
  ) -> Bool {
    // Only with no tmux client attached: nobody can type into a pane without one, so nothing the owner types can be in the way of the
    // Backspaces. With one attached our line is held like any other text (the owner is at the pane, and the thread is told).
    if ours, r.owed.clears < 3, !attached {
      if mayAct, clearOurLine(id) { rt[id]?.owed.clears += 1 }
      return true
    }
    // typed by us (the flag, or the line itself) and not alone in a box we can read: it may be mixed with the owner's text
    if r.enterOwed || ours, ours || draft || !box {
      rt[id]?.owed.leftover = true
      noteHeldPointer(id, ours || draft ? .draft : .noBox)
      return true
    }
    dropOwed(id)
    return false
  }

  /// One more look right before a send: ONE read, with the colours, so the text and its intensity are of the same moment; the plain
  /// text is that read with the escapes stripped. The box holds our line and nothing else, at normal intensity (a colour read that finds
  /// no box is not a yes), and no dialog is up. The Enter goes only onto this; an empty box, a box with more in it, no box, and a read
  /// that fails all send nothing. `looks` > 1: the screen is given a moment to show it. A read that fails ends the looks: each can take
  /// seconds, and the queue it runs on serves every worker.
  private func boxHoldsOnlyOurLine(_ id: String, looks: Int = 1) -> Bool {
    for k in 0..<looks {
      if k > 0 { usleep(30_000) }
      let again = run(tmux(id).capturePaneEscaped())
      guard again.ok else { return false }
      let escaped = TmuxCommands.parseCapture(again.out)
      let rows = escaped.map(InputBoxAttributes.stripEscapes)
      if PointerTyper.boxText(rows: rows) == PointerTyper.text, InputBoxAttributes.draftPresent(escapedRows: escaped) == true,
        guardShape(rows) == .none
      {
        return true
      }
    }
    return false
  }

  /// Backspace for exactly our line, after one more look right before sending (`boxHoldsOnlyOurLine`), and still no client attached.
  /// Nobody can type into a pane without a client, so a Backspace can only ever delete our own characters: a cursor moved into the
  /// line deletes less, never more. A client that attaches between that look and the send has no time to type.
  private func clearOurLine(_ id: String) -> Bool {
    guard boxHoldsOnlyOurLine(id) else { return false }
    let clients = run(tmux(id).listClientsActivity())
    guard clients.ok, TmuxCommands.parseClientActivity(clients.out)?.isEmpty == true else { return false }
    // a Backspace in copy mode clears nothing, and must not count as a round: sent only if the pane is in no mode, in one invocation
    return sendUnlessInMode(tmux(id).sendBackspacesUnlessInMode(PointerTyper.text.count), id: id, intent: .box(.ours)) == .sent
  }

  /// What became of a send that is conditional on the pane's mode (`TmuxCommands.unlessInMode`). `refused`: the key guard sent nothing.
  enum ModeSend: Equatable { case sent, heldByMode, failed, timedOut, refused }

  /// Runs one `…UnlessInMode` invocation, through the key guard (`sendKey`: the live screen must be what `intent` says). `.sent` only
  /// when tmux ran it and said the keys went; an answer that is neither that nor "in a mode" is a failure, never a send.
  func sendUnlessInMode(_ argv: [String], id: String, intent: KeyGuard.Intent) -> ModeSend {
    sendUnlessInModeReading(argv, id: id, intent: intent).sent
  }

  /// `sendUnlessInMode`, with the rows the key guard read right before the send (`sendKeyReading`).
  func sendUnlessInModeReading(_ argv: [String], id: String, intent: KeyGuard.Intent) -> (sent: ModeSend, seen: [String]?) {
    let (r, seen) = sendKeyReading(id, argv, intent)
    guard let r else { return (.refused, seen) }
    if r.timedOut { return (.timedOut, seen) }
    guard r.ok, let sent = TmuxCommands.parseModeSend(r.out) else { return (.failed, seen) }
    return (sent ? .sent : .heldByMode, seen)
  }

  /// After a pointer's Enter went: the pane is read at once, then `EnterDetection.laterDelay` on and, only when that read still shows our
  /// line, once more at `EnterDetection.slowDelay` (a slow redraw), each read put in one class with the guard's read before the key
  /// (`pre`). The later reads run on this manager's queue when they are due (`queue.asyncAfter`), never as a sleep inside the tick.
  func scheduleEnterCheck(_ id: String, pre: [String]?, until: Double?) {
    let token = (rt[id]?.enterCheckToken ?? 0) &+ 1
    rt[id]?.enterCheckToken = token
    let check = EnterCheckReads(pre: EnterDetection.classify(pre), after: EnterDetection.classify(paneRows(id)), until: until)
    queue.asyncAfter(deadline: .now() + EnterDetection.laterDelay) { [weak self] in self?.enterCheckDue(id, token, check) }
  }

  /// A scheduled read of the Enter check. Nothing when the app stopped or a newer Enter's check took over.
  func enterCheckDue(_ id: String, _ token: Int, _ c: EnterCheckReads) {
    guard !stopped, rt[id]?.enterCheckToken == token else { return }
    var c = c
    let read = EnterDetection.classify(paneRows(id))
    if c.later == nil {
      c.later = read
      // still our line: one more read at the slow-redraw mark before it counts
      if read == .boxOurs {
        let wait = EnterDetection.slowDelay - EnterDetection.laterDelay
        queue.asyncAfter(deadline: .now() + wait) { [weak self] in self?.enterCheckDue(id, token, c) }
        return
      }
    } else {
      c.latest = read
    }
    guard let later = c.later, let why = EnterDetection.judge(pre: c.pre, after: c.after, later: later, latest: c.latest) else { return }
    audit(
      "\(EnterDetection.auditEvent) thread=\(id) pre=\(c.pre.rawValue) after=\(c.after.rawValue) later=\(later.rawValue) "
        + "latest=\(c.latest?.rawValue ?? "not_taken") why=\(why.rawValue)")
    // the pointer stays owed and is held, never entered again; unless a newer message came meanwhile, which is a fresh pointer of its own
    if rt[id]?.pendingPointer != true {
      rt[id]?.pendingPointer = true
      rt[id]?.enterOwed = false
      rt[id]?.owed = OwedState(until: c.until)
      rt[id]?.owed.enterUncertain = true
      noteHeldPointer(id, .enterUncertain)
    }
    sendNotice(id, \.enterHold, kind: WorkerNotice.enterUncertainKind, text: WorkerNotice.enterUncertainLine())
    dirty = true
  }

  /// Whether the pane is in a tmux mode (copy mode, after the owner scrolled back): nil when that cannot be read, whether tmux failed,
  /// timed out or answered with something that is neither 0 nor 1. Callers send keys only on `false`.
  func inCopyMode(_ id: String) -> Bool? {
    let r = run(tmux(id).paneInMode())
    return r.ok ? TmuxCommands.parseInMode(r.out) : nil
  }
}
