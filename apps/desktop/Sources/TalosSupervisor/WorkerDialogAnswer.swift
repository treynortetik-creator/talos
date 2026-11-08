import Foundation
import TalosDesktopCore

/// Needs-you prompts: a tap's answer for the dialog a worker's pane shows. The one narrow exception to "nothing is ever typed into a
/// dialog", and only this: an answer file from the bridge (`workers/<id>/dialog-answer.json`) that PROVES ITSELF (`isAuthentic`, the
/// owner's signature checked against devices.json and against the Mac's own record of the dialog) for the CURRENT offered dialog, taken
/// once, becomes Up or Down presses and one Enter, each decided on a fresh read of the screen.
///
/// Every guard, in order: the thread's folder is a real folder, not a link; the file is read with the hardening of an agent request (a
/// link, a big file, a wrong or extra field is nothing); it is taken off the folder before anything is done, so no crash can act on it
/// twice; each control id is acted on once, ever (in memory and in the last result); it is not older than five minutes; it names the
/// current dialog id and the card has not expired; THE PROOF (nothing in the file is believed otherwise: the key must be a paired device's in
/// devices.json, the signature must verify, what was signed must be this card for this dialog as the Mac recorded it, and the Mac has pressed
/// nothing for this dialog id before); no tmux client typed within `clientQuiet`; the screen is read again, as the same kind of dialog with the
/// same labels (and the same subject, if the offer had one). Then ONE arrow at a time, each followed by a read that must show the highlighted
/// row one step on; Enter only when the highlighted label is the signed choice's, never twice for one dialog. Anything else sends nothing
/// more and the result says "nothing pressed" and why. A key whose send timed out counts as sent: it is never repeated.
extension WorkerManager {
  /// How long an arrow gets to show on the screen, and the pause between looks. Claude redraws within a frame; this is slack for a busy Mac.
  static let echoWait: Double = 2
  static let echoPoll: UInt32 = 50_000

  struct AnswerOutcome {
    var outcome: DialogResult.Outcome
    var choice: Int?
    var label: String?
    var reason: DialogResult.Reason?
    /// Why nothing was pressed when it was the typing guard (only the popup tells the owner: a card answer says `screen_changed` as before).
    var blocked: Blocked?
    enum Blocked { case typing, unreadable }
    static func nothing(_ why: DialogResult.Reason? = .screenChanged) -> AnswerOutcome { .init(outcome: .nothingPressed, reason: why) }
    static func blocked(_ b: Blocked) -> AnswerOutcome { .init(outcome: .nothingPressed, reason: .screenChanged, blocked: b) }
  }

  func answerDialog(_ id: String) {
    // Only an offer THIS process has seen on the screen: a record read back from workers.json after a relaunch is nothing to press on until
    // the dialog is seen to hold still (syncOffer), and then it is the screen's own read.
    guard folderIsReal(id) else { return }
    guard let offer = rt[id]?.entry.dialog, rt[id]?.offer.sinceAwake != nil else { return answerLate(id) }
    let path = dir(id) + "/" + DialogAnswerRequest.fileName
    let taken = path + ".taken"
    guard rename(path, taken) == 0 else { return }  // taken atomically: a rewrite by the bridge lands in a new file
    let read = DialogAnswerFile.read(path: taken)
    unlink(taken)
    guard case .answer(let a) = read else { return }  // not an answer: there is no control id to say anything to
    let resultPath = dir(id) + "/" + DialogResult.fileName
    if rt[id]?.offer.controlsSeen.contains(a.controlId) == true || DialogResult.controlId(path: resultPath) == a.controlId { return }
    let seenBefore = rt[id]?.offer.controlsSeen ?? []
    rt[id]?.offer.controlsSeen = Array((seenBefore + [a.controlId]).suffix(64))
    let o = take(id, offer, a)
    guard folderIsReal(id) else { return }
    let data = DialogResult.encode(dialogId: a.dialogId, controlId: a.controlId, outcome: o.outcome, choice: o.choice, label: o.label, reason: o.reason, at: now())
    try? AtomicFile.write(data, to: resultPath, mode: 0o600)
  }

  /// An answer that comes when no dialog is on offer, for the dialog the Mac itself already pressed or opened (a click on the popup, or an
  /// earlier answer, and the dialog has left the pane since): there is nothing to check it against, but the Mac knows it was answered, so
  /// the later answer gets `already_answered` for its control id instead of waiting for the bridge to give up. Only an answer that names that
  /// dialog id is taken; any other is left where it is. Each control id once, the same file rules as every result.
  private func answerLate(_ id: String) {
    guard let r = rt[id] else { return }
    let answered = [r.offer.enterSentFor, r.offer.openedFor].compactMap { $0 }
    guard !answered.isEmpty else { return }
    let path = dir(id) + "/" + DialogAnswerRequest.fileName
    guard case .answer(let peek) = DialogAnswerFile.read(path: path), answered.contains(where: { ExactText.equal($0, peek.dialogId) }) else { return }
    let taken = path + ".taken"
    guard rename(path, taken) == 0 else { return }
    let read = DialogAnswerFile.read(path: taken)
    unlink(taken)
    guard case .answer(let a) = read, answered.contains(where: { ExactText.equal($0, a.dialogId) }), !a.isStale(nowMs: now() * 1000) else { return }
    let resultPath = dir(id) + "/" + DialogResult.fileName
    if rt[id]?.offer.controlsSeen.contains(a.controlId) == true || DialogResult.controlId(path: resultPath) == a.controlId { return }
    let seenBefore = rt[id]?.offer.controlsSeen ?? []
    rt[id]?.offer.controlsSeen = Array((seenBefore + [a.controlId]).suffix(64))
    guard folderIsReal(id) else { return }
    let data = DialogResult.encode(dialogId: a.dialogId, controlId: a.controlId, outcome: .nothingPressed, reason: .alreadyAnswered, at: now())
    try? AtomicFile.write(data, to: resultPath, mode: 0o600)
  }

  /// Whether this answer is the owner's: the one place that decides it, so where the proof's key comes from can change without touching the
  /// rest. The Mac's own record of the dialog (`offer`, in memory) is what the signed card must equal.
  func isAuthentic(_ id: String, _ offer: DialogOffer, _ a: DialogAnswerRequest) -> DialogProofCheck.Verdict {
    let pane = DialogProofCheck.Pane(thread: id, dialogId: offer.id, kind: offer.kind, subject: offer.subject, options: offer.options)
    let devices = options.talosHome + "/devices.json"
    return DialogProofCheck.verify(
      a,
      env: .init(
        pinnedKey: { DeviceKeys.pinnedKey($0, devicesPath: devices) }, nowMs: now() * 1000, pane: pane,
        alreadyPressed: rt[id]?.offer.pressed(offer.id) == true))
  }

  private func take(_ id: String, _ offer: DialogOffer, _ a: DialogAnswerRequest) -> AnswerOutcome {
    guard !a.isStale(nowMs: now() * 1000) else { return .nothing(.unverified) }
    guard ExactText.equal(a.dialogId, offer.id) else { return .nothing(.unverified) }  // not the dialog on this pane
    guard let expires = ISOTime.parse(offer.expires_at), now() < expires else { return .nothing() }
    // a signed tap is used once per dialog, whatever came of it (the control id is not signed)
    let used = a.dialogId + "|" + a.proof.osig
    guard rt[id]?.offer.proofsUsed.contains(used) != true else { return .nothing(.alreadyAnswered) }
    switch isAuthentic(id, offer, a) {
    case .no(let why, _): return .nothing(why)
    case .ok(let choice, let label, _):
      let before = rt[id]?.offer.proofsUsed ?? []
      rt[id]?.offer.proofsUsed = Array((before + [used]).suffix(64))
      guard let choice, let label else {
        // login: no key. The Terminals window comes to the thread. With no window to bring (no handler, or it can't), nothing happened.
        guard let open = openTerminals, open(id) else { return .nothing(nil) }
        rt[id]?.offer.openedFor = offer.id  // once per dialog id, for the popup's button too
        return .init(outcome: .opened)
      }
      return press(id, offer, choice, label)
    }
  }

  /// The screen as `DialogReader` reads it, with a few tries: the plain capture and the one with colours are two looks.
  private func readDialog(_ id: String, tries: Int = 3) -> DialogReader.Dialog? {
    for k in 0..<tries {
      if k > 0 { usleep(100_000) }
      if let d = lookAtDialog(id) { return d }
    }
    return nil
  }

  private func lookAtDialog(_ id: String) -> DialogReader.Dialog? {
    let plain = run(tmux(id).capturePane())
    let coloured = run(tmux(id).capturePaneEscaped())
    guard plain.ok, coloured.ok else { return nil }
    return DialogReader.read(rows: TmuxCommands.parseCapture(plain.out), escapedRows: TmuxCommands.parseCapture(coloured.out))
  }

  /// Whether a tmux client may be typing: one typed within `clientQuiet` (`.typing`), or the clients could not be read (`.unreadable`). Unlike
  /// the pointer's guard, which says "not typing" for what it cannot read, a key into a dialog is never sent on a guess.
  private func typingBlock(_ id: String) -> AnswerOutcome.Blocked? {
    let c = run(tmux(id).listClientsActivity())
    guard c.ok, let times = TmuxCommands.parseClientActivity(c.out) else { return .unreadable }
    guard let last = times.max() else { return nil }
    return now() - last < options.clientQuiet ? .typing : nil
  }

  func press(_ id: String, _ offer: DialogOffer, _ choice: Int, _ chosen: String) -> AnswerOutcome {
    for _ in 0...offer.options.count {
      if let b = typingBlock(id) { return .blocked(b) }
      let fresh = readDialog(id)
      guard case .keys(let keys) = DialogAnswer.plan(offered: offer.dialog, fresh: fresh, choice: choice), let key = keys.first, let from = fresh?.cursor
      else { return .nothing() }
      if key == .enter {
        // the typing check, then the last look, then the Enter: the Enter goes only onto the signed choice's row, as just seen
        if let b = typingBlock(id) { return .blocked(b) }
        guard let last = readDialog(id), DialogAnswer.differs(offered: offer.dialog, fresh: last) == nil, let c = last.cursor,
          last.options.indices.contains(c), ExactText.equal(last.options[c], chosen)
        else { return .nothing() }
        let sent = run(tmux(id).sendDialogKey(.enter))
        guard sent.ok || sent.timedOut else { return .nothing() }  // a timeout may have been delivered: counted, never repeated
        rt[id]?.offer.enterSentFor = offer.id
        return .init(outcome: .pressed, choice: choice, label: chosen)
      }
      let sent = run(tmux(id).sendDialogKey(key))
      guard sent.ok || sent.timedOut, moved(id, offer, key, from: from) else { return .nothing() }
    }
    return .nothing()
  }

  /// Waits for the arrow to show: the same dialog with the highlighted row one step on. A read that fails while Claude redraws is looked at
  /// again; a different dialog, or the row anywhere else but where it was, ends it.
  private func moved(_ id: String, _ offer: DialogOffer, _ key: DialogKey, from: Int) -> Bool {
    let until = awake() + Self.echoWait
    repeat {
      usleep(Self.echoPoll)
      guard let fresh = lookAtDialog(id) else { continue }
      if DialogAnswer.differs(offered: offer.dialog, fresh: fresh) != nil { return false }
      if DialogAnswer.moved(key, from: from, to: fresh.cursor) { return true }
      if fresh.cursor != from { return false }
    } while awake() < until
    return false
  }
}
