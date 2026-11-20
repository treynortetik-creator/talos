import Foundation
import TalosDesktopCore

/// Main's two safety questions as a Mac popup: the MCP server approval ("New MCP server found in this project: <name>") and the Bypass
/// Permissions disclaimer ("WARNING: Claude Code running in Bypass Permissions mode"). Pane-prompts plan rows 2 and 4.
///
/// Main's bridge is Main's own child, so while Main sits on either question NO bridge runs and no phone card can be made (the same as the
/// development-channels warning, `SupervisorDevCard`): the popup is the card, and the phone is told once, by a line from the Mac itself, that Main
/// waits here. The popup lists the screen's own rows as buttons ("Use this MCP server", "Continue without using this MCP server"; "No, exit",
/// "Yes, I accept").
///
/// THE HARD RULE: these answer SAFETY questions, so only a person's own click answers them. A click reaches `safetyClick` only from the popup
/// button's action (`NeedsYouPopupView.isRealClick` drops every other press before the controller hears of it): no file, URL scheme, AppleScript,
/// Accessibility press or tool call asks for it. Nothing in this file reads an answer from disk, and no automatic path answers either question.
/// The key goes through the key gate (`sendKey(.dialog(kind))`: the live screen must be exactly that dialog), after a fresh read of the screen before
/// each key, one arrow at a time toward the clicked row, and the Enter only onto that row, never while a tmux client may be typing.
extension Supervisor {
  static let safetyLifetime: Double = 900

  /// The needs-you label of the question on screen (`DialogMatcher.Screen.label`): what the menu line and the setup screen name it by.
  static func safetyLabel(_ kind: DialogReader.Kind) -> String {
    kind == .bypass ? DialogMatcher.Screen.bypassDisclaimer.label : DialogMatcher.Screen.mcpConsent.label
  }

  static func isSafetyLabel(_ label: String) -> Bool {
    label == safetyLabel(.bypass) || label == safetyLabel(.mcpConsent)
  }

  /// Offers the question on Main's pane (read exactly, with the server name on it), or ends the offer when it is not on the screen now. The
  /// same sighting keeps its offer (and its popup); a different one (another server) is a new sighting with a new id.
  func mainSafetyQuestions(_ rows: [String], launch l: inout Launch) {
    let screen = rows.joined(separator: "\n")
    // the screen an answer's Enter went to, still unchanged: that question is answered, not offered again
    if let answered = l.safetyAnsweredScreen {
      if answered == screen { return }
      l.safetyAnsweredScreen = nil
    }
    // an Enter that may or may not have landed: the same screen waits out the short memory, then is offered again
    if let unsent = l.safetyUnsentScreen {
      if unsent == screen, options.awake() < l.safetyUnsentUntil { return }
      l.safetyUnsentScreen = nil
    }
    guard let d = DialogReader.read(rows: rows, mcpNames: WorkerMcp.projectNames(cwd: l.agentDir)),
      d.kind == .bypass || (d.kind == .mcpConsent && d.subject != nil)
    else { return endSafetyOffer(&l) }
    let seen = options.wallClock() / 1000
    if let o = l.safetyOffer, o.kind == d.kind, ExactText.equal(o.subject, d.subject), ExactText.equal(o.options, d.options),
      let expires = ISOTime.parse(o.expires_at), seen < expires
    {
      return
    }
    let o = DialogOffer(
      id: DialogOffer.newId(), kind: d.kind, subject: d.subject, options: d.options, cursor: d.cursor, seen_at: ISOTime.string(seen),
      expires_at: ISOTime.string(seen + Self.safetyLifetime))
    guard o.isValid else { return }
    l.safetyOffer = o
    l.safetyPressedFor = nil
    audit("main_safety_offered", ["session": l.sessionId, "kind": d.kind.rawValue])
    // named at once (the same key the dialog stall uses, so it is raised once): the menu line and the setup screen say "answer in the popup"
    raiseNeedsYou(.dialog(Self.safetyLabel(d.kind)), key: "stall:\(Self.safetyLabel(d.kind))", launch: &l)
    postSafetyWaitingToPhone(launch: &l)
  }

  func endSafetyOffer(_ l: inout Launch) {
    guard l.safetyOffer != nil else { return }
    l.safetyOffer = nil
  }

  /// The popup item for Main's safety question, while it is offered and not past its time.
  func safetyPopupItem() -> NeedsYouPopupItem? {
    guard let d = status.safetyDialog, d.isValid, (ISOTime.parse(d.expires_at) ?? 0) > options.wallClock() / 1000 else { return nil }
    return NeedsYouPopupItem(thread: Self.mainPopupThread, threadName: "Main", dialog: d, phoneTold: status.safetyPhoneTold, first: true)
  }

  /// One plain line to the phone per start, only when the owner is probably not at the Mac (a cold start the phone or a recovery began, or a crash
  /// restart): Main waits at the Mac, and the answer is the popup there. It needs no bridge (the Mac runs the command itself).
  private func postSafetyWaitingToPhone(launch l: inout Launch) {
    guard !l.safetyPhonePosted, recovery.postColdStart || l.kind == .supervisorRestart else { return }
    l.safetyPhonePosted = true
    l.safetyPhoneTold = postToPhone { _ in NeedsYouPopupContent.devWaitingPhone }
  }

  /// A click on button `choiceIndex` of Main's safety popup, after the popup layer has checked it was the owner's own hand. One key per sighting:
  /// the arrow toward the chosen row from a fresh read, then Enter once it is the highlighted row; anything else sends nothing more.
  func safetyClick(_ choiceIndex: Int, label: String, offer: DialogOffer, launch l: inout Launch) -> PopupAnswerResult {
    guard offer.kind == .bypass || offer.kind == .mcpConsent, let intent = KeyGuard.intent(for: offer.kind),
      offer.options.indices.contains(choiceIndex), ExactText.equal(offer.options[choiceIndex], label)
    else { return .nothing(.screenChanged) }
    guard l.safetyPressedFor != offer.id else { return .nothing(.alreadyAnswered(by: nil)) }
    guard !clientsMayBeTyping() else { return .nothing(.typing) }
    let names = WorkerMcp.projectNames(cwd: l.agentDir)
    for _ in 0...offer.options.count {
      guard let rows = host.visibleRows(), !DialogMatcher.takesNoKeys(rows) else { return .nothing(.couldNotCheck) }
      // the same dialog as the popup showed: the kind, the rows, and the server when there was one
      guard let fresh = DialogReader.read(rows: rows, mcpNames: names), DialogAnswer.differs(offered: offer.dialog, fresh: fresh) == nil,
        case .keys(let keys) = DialogAnswer.plan(offered: offer.dialog, fresh: fresh, choice: choiceIndex), let key = keys.first
      else { return .nothing(.screenChanged) }
      if key == .enter {
        // the typing check again, then the last look, straight before the Enter: it goes only onto the clicked row, as just seen
        guard !clientsMayBeTyping() else { return .nothing(.typing) }
        guard let lastRows = host.visibleRows(), !DialogMatcher.takesNoKeys(lastRows),
          let last = DialogReader.read(rows: lastRows, mcpNames: names), DialogAnswer.differs(offered: offer.dialog, fresh: last) == nil,
          let c = last.cursor, last.options.indices.contains(c), ExactText.equal(last.options[c], label)
        else { return .nothing(.screenChanged) }
        let sent = sendKey(intent) { $0.sendDialogKey(.enter) }
        if sent.notSent {
          audit("main_safety_send_failed", ["session": l.sessionId, "pid": "\(l.childPid)"])
          return .nothing(.screenChanged)
        }
        l.safetyPressedFor = offer.id
        if sent == .sent {
          // "No, exit" ends the process: the owner's own stop, not a crash (`stopsForOwnerExit`)
          if offer.kind == .bypass, !label.hasPrefix("Yes") { l.safetyOwnerExit = true }
          l.safetyAnsweredScreen = lastRows.joined(separator: "\n")
        } else {
          // delivery unknown (a timeout): neither answered for good nor an owner exit. Remembered only briefly, so a key that never arrived is asked again
          l.safetyUnsentScreen = lastRows.joined(separator: "\n")
          l.safetyUnsentUntil = options.awake() + timings.safetyUnsentMemory
          audit("main_safety_send_unconfirmed", ["session": l.sessionId, "dialog": offer.id])
        }
        l.safetyOffer = nil
        if sent == .sent { audit("main_safety_answered", ["session": l.sessionId, "kind": offer.kind.rawValue, "choice": "\(choiceIndex)", "dialog": offer.id]) }
        return .pressed(choice: choiceIndex, label: label)
      }
      if sendKey(intent, { $0.sendDialogKey(key) }).notSent { return .nothing(.screenChanged) }
      usleep(150_000)  // the arrow shows on the next draw; the loop reads the screen again before any further key
    }
    return .nothing(.screenChanged)
  }
}
