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
/// empty box that the screen has had the chance to fill means the text is gone, and the whole line is typed again; the box decides
/// that, not whether a draft hold was running or an earlier look was taken (only `unseenSince` says the screen may not have caught
/// up yet), so a frame caught mid-redraw cannot turn the Enter into a keystroke on nothing (Claude drops it, the pointer is marked
/// done, and the message goes to main). A line past its deadline is taken out of the box with
/// Backspace, once per tick and at most three times, and only when the box holds exactly that line AND no tmux client is attached
/// (nobody can type into a pane without one, so a Backspace can only delete our own characters). Text that may be the owner's, or any
/// line while a client is attached, is never cleared, and the thread is told (`leftoverLine`).

/// The part of a worker's runtime that is only about the owed pointer. Reset whenever nothing is owed (`Runtime.pendingPointer`).
struct OwedState {
  /// The claim deadline (wall clock) of the oldest wake this pointer answers.
  var until: Double?
  /// Read from `workers.json` by this copy and not yet typed or dropped: its deadline is checked up to the moment it is typed.
  var restored = false
  /// A start for a restored pointer on a sleeping worker has been asked for.
  var revived = false
  /// When our line was typed (awake clock), until a look at the box has shown text in it: the screen may not have caught up yet, so
  /// an empty box is not "gone" (the line would be typed twice, read as the owner's draft and held). nil: seen, or typed by an earlier
  /// copy of the app, whose first look at the box counts as the screen having caught up.
  var unseenSince: Double?
  /// The line was typed again because `screenLag` passed without the box showing it: once per unseen episode, since the keys may
  /// only have been buffered (both copies would land) and a second retype would add a third. Cleared when text is seen.
  var retyped = false
  /// Past its deadline, and the box holds something that may include our line: held, not cleared.
  var leftover = false
  /// Backspace rounds sent to clear our own line; three that did not clear it leave it alone.
  var clears = 0
}

extension WorkerManager.Runtime {
  /// The entry as `workers.json` has it: what is owed, from the flags the loop already keeps. The fields are written when set and
  /// left out when not, so the file of a thread owing nothing is the file of every earlier build.
  var persisted: WorkersFile.Entry {
    var e = entry
    e.pointer_owed_until = pendingPointer ? owed.until.map(ISOTime.string) : nil
    e.enter_owed = pendingPointer && enterOwed ? true : nil
    if !WorkerManager.offerStates.contains(entry.state) { e.dialog = nil }  // no pane, no dialog on it
    e.last_active_at = savedActivity
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
    entry.pointer_owed_until = nil
    entry.enter_owed = nil
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
    rt[id]?.owePointer(cold: cold, now: t, wakeAt: wakeAt)
    if rt[id]?.persisted.pointer_owed_until != before { writeFile() }
  }

  private static let hasPane: Set<String> = ["starting", "live", "busy"]

  /// How long after typing (awake clock) an empty box is still read as a screen that has not caught up. Claude draws a typed line
  /// within a frame; past this the keys were dropped, or are only buffered, and the line is typed again, once (`OwedState.retyped`).
  static let screenLag: Double = 5
  private static let looksAfterTyping = 10

  func dropOwed(_ id: String) {
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
    // the typing guard, like the screen: unread is not "nobody is typing"
    let clients = run(tmux(id).listClientsActivity())
    guard clients.ok, let activity = TmuxCommands.parseClientActivity(clients.out) else { return true }
    let box = PointerTyper.inputBox(rows: rows) != nil
    // Text in the box (at normal intensity: a dim placeholder or suggestion is not text). Our own line, exactly, is ours whether or
    // not the flag says so (the app can go between the text and its flag), and is never an owner's draft. Anything else is the
    // owner's: more than our line included.
    let typed = draftPresent(id, rows)
    let ours = typed && PointerTyper.boxText(rows: rows) == PointerTyper.text
    let draft = typed && !ours
    let shape = scr == .none ? guardShape(rows) : scr
    // The box is on the screen and holds nothing: the text we typed is gone, because the owner held us off and then cleared it, or
    // because the owner cleared it while the app was away (then Enter would go into an empty box and the message would be lost).
    // Not whenever the box reads empty, though: right after we typed, it may only be a screen that has not caught up with the text, so
    // the box must have shown text since (`unseenSince` nil), or `screenLag` have passed without it, and then once (`retyped`: the
    // keys may only be buffered, and each further copy would land too).
    let unseen = r.owed.unseenSince
    let lagged = unseen.map { awake() - $0 > Self.screenLag } ?? false
    if r.enterOwed, box, !typed, unseen == nil || (lagged && !r.owed.retyped) {
      rt[id]?.enterOwed = false
      if unseen != nil { rt[id]?.owed.retyped = true }
    }
    if typed {
      rt[id]?.owed.unseenSince = nil
      rt[id]?.owed.retyped = false
    }
    if ours { rt[id]?.enterOwed = true }
    // a pointer from an earlier copy of the app is never typed past its deadline, however long it was held back since
    if r.owed.restored, t > (r.owed.until ?? 0) {
      let mayAct = PointerTyper.mayType(screen: shape, lastClientActivity: nil, now: t, draftPresent: false, boxVisible: box)
      return settleLate(id, r, ours: ours, draft: draft, box: box, mayAct: mayAct, attached: !activity.isEmpty)
    }
    noteHeldPointer(id, draft ? .draft : box ? .none : .noBox)  // an owed Enter with no box on the pane is held too
    guard PointerTyper.mayType(screen: shape, lastClientActivity: activity.max(), now: t, draftPresent: draft, boxVisible: box) else {
      return false
    }
    var justTyped = false
    if rt[id]?.enterOwed != true {
      guard run(tmux(id).sendLiteral(PointerTyper.text)).ok else { return true }
      rt[id]?.enterOwed = true
      rt[id]?.owed.unseenSince = awake()
      justTyped = true
      writeFile()  // the text is in the box: a relaunch from here on must know it is ours
    }
    // Right after our own typing the screen may not show the text yet, so it is looked for a moment (Claude draws a typed line within a
    // frame: ten looks with nine 30 ms pauses, about 0.27 s, are plenty); if it still is not there the Enter waits for a later tick, and the empty box is not read as
    // "gone" until the line has been seen (`unseenSince`). Never an Enter on a look that does not show exactly our line.
    guard boxHoldsOnlyOurLine(id, looks: justTyped ? Self.looksAfterTyping : 1), run(tmux(id).sendEnter()).ok else { return true }
    rt[id]?.enterOwed = false
    rt[id]?.pendingPointer = false
    noteHeldPointer(id, .none)
    rt[id]?.lastActive = t
    rt[id]?.entry.last_turn_at = ISOTime.string(t)
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
    return run(tmux(id).sendBackspaces(PointerTyper.text.count)).ok
  }
}
