import Foundation
import TalosDesktopCore

/// Main's tool permission and the agent's own question (pane-prompts plan rows 8 and 9) as a Needs-you offer: a Mac popup with the owner's choices as
/// buttons, and, through `supervisor.main_dialog` in workers.json, a phone card the bridge makes (Main's bridge runs while Main works, unlike at its
/// startup questions). The owner's words, not the screen's rows: a tool permission offers `Allow once` and `Deny` only (a standing grant stays at the
/// Mac), a question offers its rows, with the free-text one as `Other…` on the phone card (a popup has no text field).
///
/// THE HARD RULE: a tool permission is a SAFETY prompt, and the agent's question is the owner's own, so only a person's tap answers either. A click
/// reaches `paneClick` only from the popup button's action (`NeedsYouPopupView.isRealClick` drops every other press before the controller hears of
/// it); a phone answer reaches `takePaneAnswer` only as the owner's signature from a paired device, checked against devices.json and this file's own
/// record of the offer (`DialogProofCheck`). No file, URL scheme, AppleScript, Accessibility press, agent or tool call asks for either.
///
/// Every key is checked against the screen the offer was made for (`PaneAnswerDriver`, `KeyGuard.Intent.pane`), after a fresh read, and never while a
/// tmux client may be typing. A key whose delivery is unknown is remembered briefly (`Timings.safetyUnsentMemory`), and the unchanged screen is offered
/// again after it, as the safety popups do.
extension Supervisor {
  static let paneLifetime: Double = 900

  /// The phone line for a standing offer whose card the phone has not acknowledged (the bridge is down, or the relay has no card feature): after
  /// `paneCardWait`, once per offer, through the CLI path (`postToPhone`). A card the bridge acknowledged (`dialog-card.json` naming the offer)
  /// is its own notice and gets no line.
  private func paneLineIfNoCard(_ rows: [String], launch l: inout Launch, now: Double) {
    guard let o = l.paneOffer, l.paneLineFor != o.id, now - l.paneOfferedAt >= timings.paneCardWait else { return }
    if let thread = defaultThread, DialogCardAck.dialogId(path: talosAppHome + "/workers/" + thread + "/" + DialogCardAck.fileName) == o.id { return }
    l.paneLineFor = o.id
    guard let p = PromptDetector.detect(rows) else { return }
    audit("main_pane_line", ["session": l.sessionId, "kind": o.kind.rawValue])
    postToPhone(asMac: false) { SupervisorNotice.mainPromptLine(agentName: $0, prompt: p) }
  }

  /// One look at Main's readable screen.
  func mainPaneSelect(_ rows: [String], launch l: inout Launch, now: Double) {
    defer { paneLineIfNoCard(rows, launch: &l, now: now) }
    guard let s = PaneSelect.read(rows: rows) else {
      l.paneSeen = nil
      if l.paneGone == nil { l.paneGone = now }
      // gone for `promptSettle`: the offer is over, and an answered or unsent screen is forgotten (a redraw for a moment is not the end)
      if now - (l.paneGone ?? now) >= timings.promptSettle {
        if l.paneOffer != nil { l.paneOffer = nil }
        l.paneAnswered = nil
        l.paneUnsent = nil
      }
      return
    }
    l.paneGone = nil
    if l.paneSeen != s.bound {
      l.paneSeen = s.bound
      l.paneSince = now
    }
    // another screen in place of the offered one: that offer is over (a click or a tap for it presses nothing)
    if l.paneOffer != nil, l.paneBound != s.bound { l.paneOffer = nil }
    if let a = l.paneAnswered {
      if a == s.bound { return }
      l.paneAnswered = nil
    }
    if let u = l.paneUnsent {
      if u == s.bound, options.awake() < l.paneUnsentUntil { return }
      l.paneUnsent = nil
    }
    guard now - l.paneSince >= timings.promptSettle else { return }
    let seen = options.wallClock() / 1000
    if let o = l.paneOffer, l.paneBound == s.bound, let expires = ISOTime.parse(o.expires_at), seen < expires { return }
    let o = DialogOffer(
      id: DialogOffer.newId(), kind: s.kind == .toolPermission ? .toolPermission : .agentQuestion, subject: s.displaySubject,
      options: PaneSelect.offered(s), cursor: nil, free_text: PaneSelect.freeTextOption(s), seen_at: ISOTime.string(seen),
      expires_at: ISOTime.string(seen + Self.paneLifetime))
    guard o.isValid else { return }
    l.paneOffer = o
    l.paneOfferedAt = now
    l.paneBound = s.bound
    l.panePressedFor = nil
    audit("main_pane_offered", ["session": l.sessionId, "kind": o.kind.rawValue])
  }

  /// The popup item for Main's tool permission or question, while it is offered and not past its time.
  func panePopupItem() -> NeedsYouPopupItem? {
    guard let d = status.paneDialog, d.isValid, (ISOTime.parse(d.expires_at) ?? 0) > options.wallClock() / 1000 else { return nil }
    return NeedsYouPopupItem(thread: Self.mainPopupThread, threadName: "Main", dialog: d, phoneTold: false, first: true)
  }

  /// What a click or a verified tap on Main's offer does to the pane, and what is remembered of it. `text`: the owner's own signed words, for the free-text option.
  private func pressPane(_ offer: DialogOffer, _ choice: Int, text: String?, launch l: inout Launch) -> PaneAnswerDriver.Result {
    guard let bound = l.paneBound, let kind = PaneSelect.Kind(rawValue: offer.kind.rawValue) else { return .changed }
    let driver = PaneAnswerDriver(
      kind: kind, bound: bound, freeText: offer.free_text,
      read: { [self] in host.visibleRows() },
      typing: { [self] in clientsMayBeTyping() ? .typing : nil },
      send: { [self] step, intent in
        switch step {
        case .number(let n): return sendKey(intent) { $0.sendSelectNumber(n) }
        case .text(let t): return sendKey(intent) { $0.sendAnswerText(t) }
        case .enter: return sendKey(intent) { $0.sendDialogKey(.enter) }
        }
      },
      awake: { [self] in options.awake() }, echoWait: WorkerManager.echoWait)
    let r = driver.run(option: choice, text: text)
    switch r {
    case .delivered:
      l.panePressedFor = offer.id
      l.paneAnswered = bound
      l.paneOffer = nil
      audit("main_pane_answered", ["session": l.sessionId, "kind": offer.kind.rawValue, "choice": "\(choice)", "dialog": offer.id])
    case .unknown, .partial:
      // delivery unknown, or a free-text answer stopped after its first key: this offer is spent; the unchanged screen is offered again after the memory
      l.panePressedFor = offer.id
      l.paneUnsent = bound
      l.paneUnsentUntil = options.awake() + timings.safetyUnsentMemory
      l.paneOffer = nil
      audit(r == .partial ? "main_pane_partial" : "main_pane_send_unconfirmed", ["session": l.sessionId, "dialog": offer.id])
    case .blocked, .changed: break
    }
    return r
  }

  /// A click on button `choiceIndex` of Main's popup, after the popup layer has checked it was the owner's own hand.
  func paneClick(_ choice: Int, label: String, offer: DialogOffer, launch l: inout Launch) -> PopupAnswerResult {
    guard offer.kind == .toolPermission || offer.kind == .agentQuestion, offer.options.indices.contains(choice),
      ExactText.equal(offer.options[choice], label), choice != offer.free_text, ExactText.equal(offer.id, l.paneOffer?.id ?? "")
    else { return .nothing(.screenChanged) }
    guard l.panePressedFor != offer.id else { return .nothing(.alreadyAnswered(by: nil)) }
    switch pressPane(offer, choice, text: nil, launch: &l) {
    case .delivered: return .pressed(choice: choice, label: label)
    case .unknown: return .nothing(.unconfirmed)
    case .blocked(let b): return .nothing(b == .typing ? .typing : .couldNotCheck)
    case .changed, .partial: return .nothing(.screenChanged)
    }
  }

  /// The owner's tap on the phone card, if one came (`main-dialog-answer.json`, beside the development-channels card's): taken off the folder first,
  /// checked as the owner's own (`DialogProofCheck`), then pressed once.
  func takePaneAnswer(launch l: inout Launch) {
    guard let offer = l.paneOffer, let thread = defaultThread, WorkerSpec.isThreadId(thread) else { return }
    let dir = talosAppHome + "/workers/" + thread
    guard SafePath.isRealFolder(talosAppHome + "/workers"), SafePath.isRealFolder(dir) else { return }
    let path = dir + "/" + Self.mainAnswerFile
    let taken = path + ".taken"
    guard rename(path, taken) == 0 else { return }
    let read = DialogAnswerFile.read(path: taken)
    unlink(taken)
    guard case .answer(let a) = read else { return }
    let resultPath = dir + "/" + DialogResult.fileName
    if l.paneControlsSeen.contains(a.controlId) || DialogResult.controlId(path: resultPath) == a.controlId { return }
    l.paneControlsSeen = Array((l.paneControlsSeen + [a.controlId]).suffix(64))
    let o = takePane(offer, a, thread: thread, usedPath: dir + "/" + DialogProofsUsed.mainFileName, launch: &l)
    let data = DialogResult.encode(
      dialogId: a.dialogId, controlId: a.controlId, outcome: o.outcome, choice: o.choice, label: o.label, reason: o.reason, at: options.wallClock() / 1000)
    try? AtomicFile.write(data, to: resultPath, mode: 0o600)
  }

  private func takePane(
    _ offer: DialogOffer, _ a: DialogAnswerRequest, thread: String, usedPath: String, launch l: inout Launch
  ) -> WorkerManager.AnswerOutcome {
    let nowMs = options.wallClock()
    guard !a.isStale(nowMs: nowMs) else { return .nothing(.unverified) }
    guard ExactText.equal(a.dialogId, offer.id) else { return .nothing(.unverified) }
    guard let expires = ISOTime.parse(offer.expires_at), nowMs / 1000 < expires else { return .nothing() }
    let used = DialogProofsUsed.key(dialogId: a.dialogId, proof: a.proof)
    guard !DialogProofsUsed.contains(used, memory: l.paneProofsUsed, path: usedPath) else { return .nothing(.alreadyAnswered) }
    let pane = DialogProofCheck.Pane(
      thread: thread, dialogId: offer.id, kind: offer.kind, subject: offer.subject, options: offer.options, freeText: offer.free_text)
    let devices = talosAppHome + "/devices.json"
    let verdict = DialogProofCheck.verify(
      a,
      env: .init(pinnedKey: { DeviceKeys.pinnedKey($0, devicesPath: devices) }, nowMs: nowMs, pane: pane, alreadyPressed: l.panePressedFor == offer.id))
    switch verdict {
    case .no(let why, _): return .nothing(why)
    case .ok(let choice, let label, _):
      // on disk before the key: a tap that could not be recorded as used presses nothing
      let home = talosAppHome
      let rec = DialogProofsUsed.record(used, memory: l.paneProofsUsed, path: usedPath) {
        SafePath.isRealFolder(home + "/workers") && SafePath.isRealFolder(home + "/workers/" + thread)
      }
      l.paneProofsUsed = rec.memory
      guard rec.written else { return .nothing(nil) }
      guard let choice, let label else { return .nothing(.unverified) }
      switch pressPane(offer, choice, text: DialogProofCheck.signedText(a), launch: &l) {
      case .delivered: return .init(outcome: .pressed, choice: choice, label: label)
      case .unknown: return .init(outcome: .nothingPressed, reason: .unconfirmed)
      case .blocked(let b): return .blocked(b == .typing ? .typing : .unreadable)
      case .changed, .partial: return .nothing()
      }
    }
  }
}
