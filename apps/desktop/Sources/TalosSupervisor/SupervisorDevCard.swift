import Foundation
import TalosDesktopCore

/// Main's development-channels warning as a Needs-you offer (owner, 2026-11-07: "let's see if we can make it pop up as a Talos card I can
/// agree or decline"). When `AutoConfirmGuard` refuses the warning (every kind of refusal, a changed launch included), the refusal is offered:
/// `status.devDialog` is the Mac popup's item (SupervisorDevPopup.swift: the path while Main is stuck), and goes into `workers.json` as
/// `supervisor.main_dialog` (`WorkerManager`) for a bridge that does run. For Main the bridge is Main's own child (an MCP server of its claude
/// process), so while Main sits on this warning NO bridge runs and no card is posted: the popup, plus one line to the phone from the Mac
/// itself, is how the owner is reached. The owner's tap on a card (when a bridge does run) comes back the way a worker's does: a signed
/// `dialog-answer.json` in `workers/<default thread>/`, checked against devices.json and against this file's own record of the offer
/// (`DialogProofCheck`), then a fresh look at the screen before the key. A click on the popup is the same press.
///
/// The tap or click on "I am using this for local development" IS the owner's confirm: it stores the launch fingerprint (and its seal) like his own
/// Enter in the pane does not (`recordStartConfirmed(ownerConfirmed:)`). "Exit" presses Exit and stores nothing. Neither is ever pressed twice.
struct DevCard {
  /// The offer while the warning is on screen and was refused; nil when none (or it is over).
  var offer: DialogOffer?
  /// Looks in a row without the warning on screen; two end the offer (one blank frame between redraws does not).
  var misses = 0
  var controlsSeen: [String] = []
  /// "dialog id | signature" of every proof that checked out: one signed tap is used once.
  var proofsUsed: [String] = []
  /// The dialog id a key was sent for: no second key for it, whatever arrives.
  var pressedFor: String?
  /// The owner tapped "Exit": the process ending is his intended stop (`stopsForOwnerExit`), not a crash.
  var ownerExit = false
  /// A key for "I am using this for local development" was sent by a verified tap: its confirm is recorded, so the notice that follows is not
  /// also read as a pane Enter (`recordHumanConfirm`).
  var confirmed = false
  /// `confirmsSent` when the offer was made: an Enter the app sends after that (the guard accepted while the card stood) ends the offer, and a
  /// tap that arrives after it presses nothing.
  var confirmsAtOffer = 0
  /// The phone has been told for this start that Main waits at the Mac (`postDevWaitingToPhone`): once per start.
  var phonePosted = false
  /// ... and the post was really started (a `talos-app` and a thread were found).
  var phoneTold = false
}

extension Supervisor {
  static let devCardLifetime: Double = 900  // DIALOG_TTL_S in the protocol

  /// The exact options of the real screen (CLI 2.1.312): "1. I am using this for local development" and "2. Exit".
  static let devCardOptions = [DialogMatcher.Strings.devConfirm, DialogMatcher.Strings.devExit]

  /// What the card offers: both rows when the channels are carried whole, else Exit only. The owner cannot accept channels he cannot see.
  static func devCardOffered(subject: String?) -> [String] { subject == nil ? [DialogMatcher.Strings.devExit] : devCardOptions }

  /// What the card names: the channels as the screen showed them, comma separated; nil when the line could not be read whole.
  private func devSubject(_ d: DialogMatcher.DevChannels) -> String? {
    guard let ch = d.channels, !ch.isEmpty else { return nil }
    let s = ch.joined(separator: ", ")
    return s.count <= 500 ? s : nil
  }

  /// Whether this launch is not the one the owner confirmed, and what differs (names only). nil = it is the confirmed one.
  func launchChangedPieces(_ l: Launch) -> [String]? {
    guard !LaunchSeal.isConfirmed(config, fingerprint: l.fingerprint, parts: l.parts, trust: options.launchTrust) else { return nil }
    guard config.confirmedLaunch != nil, config.confirmedLaunchMac != nil, config.confirmedLaunch != l.fingerprint else { return [] }
    return DesktopConfig.changedPieces(confirmed: config.confirmedLaunchParts, now: l.parts)
  }

  /// Offers a refused warning to the owner as a card. Idempotent: the same warning keeps its offer (and so its card), a different one
  /// (other channels) is a new sighting with a new id.
  func offerDevDialog(_ d: DialogMatcher.DevChannels, launch l: inout Launch) {
    let subject = devSubject(d)
    let offered = Self.devCardOffered(subject: subject)
    let cursor: Int? = d.highlighted.flatMap { offered.firstIndex(of: $0) }
    let seen = options.wallClock() / 1000
    // the same sighting, still there: its card stands. One past its time (15 minutes) with the warning still on screen is offered again, new id.
    if let o = l.devCard.offer, ExactText.equal(o.subject, subject), let expires = ISOTime.parse(o.expires_at), seen < expires { return }
    let o = DialogOffer(
      id: DialogOffer.newId(), kind: .devChannels, subject: subject, options: offered, cursor: cursor,
      launch_changed: launchChangedPieces(l), seen_at: ISOTime.string(seen), expires_at: ISOTime.string(seen + Self.devCardLifetime))
    guard o.isValid else { return }
    l.devCard.offer = o
    l.devCard.pressedFor = nil
    l.devCard.misses = 0
    l.devCard.confirmsAtOffer = l.confirmsSent
    // an empty list is a launch nothing was confirmed for on this Mac (no key, the first start after the update): never an empty value
    audit("dev_card_offered", ["session": l.sessionId, "launch_changed": o.launch_changed.map { $0.isEmpty ? "unconfirmed" : $0.joined(separator: ",") } ?? "no"])
    emit(.devCardOffered(dialogId: o.id))
    postDevWaitingToPhone(launch: &l)
  }

  /// Ends the offer once the warning is off the screen (two reads in a row; a screen that could not be read says nothing) or the notice
  /// shows the channels are live.
  func syncDevCard(onScreen: Bool, unread: Bool, launch l: inout Launch) {
    // the owner's Exit is an intended stop only while that start is still waiting at the warning
    if l.noticeSeen || phase == .running { l.devCard.ownerExit = false }
    guard l.devCard.offer != nil, !unread else { return }
    l.devCard.misses = (onScreen && !l.noticeSeen) ? 0 : l.devCard.misses + 1
    // the guard confirmed (its own Enter) while the card stood: the question is answered
    if l.devCard.misses >= 2 || l.noticeSeen || l.confirmsSent > l.devCard.confirmsAtOffer {
      l.devCard.offer = nil
      l.devCard.misses = 0
      l.devCard.pressedFor = nil
    }
  }

  /// Main's own answer file, apart from `dialog-answer.json`, which a worker on the same thread folder may use.
  static let mainAnswerFile = "main-dialog-answer.json"

  /// The default thread, where the bridge puts the card and so where the answer file is (the same `default_thread` the bridge reads).
  private var defaultThread: String? { CrashPost.readAppConfig(probe.readFile(talosAppHome + "/config.json")).defaultThread }

  /// The owner's tap, if one came: taken off the folder first (so no crash can act on it twice), checked, then pressed.
  func takeDevAnswer(launch l: inout Launch) {
    guard let offer = l.devCard.offer, let thread = defaultThread, WorkerSpec.isThreadId(thread) else { return }
    let dir = talosAppHome + "/workers/" + thread
    guard SafePath.isRealFolder(talosAppHome + "/workers"), SafePath.isRealFolder(dir) else { return }
    let path = dir + "/" + Self.mainAnswerFile
    let taken = path + ".taken"
    guard rename(path, taken) == 0 else { return }
    let read = DialogAnswerFile.read(path: taken)
    unlink(taken)
    guard case .answer(let a) = read else { return }
    let resultPath = dir + "/" + DialogResult.fileName
    if l.devCard.controlsSeen.contains(a.controlId) || DialogResult.controlId(path: resultPath) == a.controlId { return }
    l.devCard.controlsSeen = Array((l.devCard.controlsSeen + [a.controlId]).suffix(64))
    let o = takeDev(offer, a, thread: thread, launch: &l)
    let data = DialogResult.encode(
      dialogId: a.dialogId, controlId: a.controlId, outcome: o.outcome, choice: o.choice, label: o.label, reason: o.reason,
      at: options.wallClock() / 1000)
    try? AtomicFile.write(data, to: resultPath, mode: 0o600)
  }

  private func takeDev(_ offer: DialogOffer, _ a: DialogAnswerRequest, thread: String, launch l: inout Launch) -> WorkerManager.AnswerOutcome {
    let nowMs = options.wallClock()
    guard !a.isStale(nowMs: nowMs) else { return .nothing(.unverified) }
    guard ExactText.equal(a.dialogId, offer.id) else { return .nothing(.unverified) }
    guard let expires = ISOTime.parse(offer.expires_at), nowMs / 1000 < expires else { return .nothing() }
    let used = a.dialogId + "|" + a.proof.osig
    guard !l.devCard.proofsUsed.contains(used) else { return .nothing(.alreadyAnswered) }
    let pane = DialogProofCheck.Pane(
      thread: thread, dialogId: offer.id, kind: .devChannels, subject: offer.subject, options: offer.options, launchChanged: offer.launch_changed)
    // a key already sent for this sighting, by a tap or by the guard's own Enter, is the one key
    let sent = l.devCard.pressedFor == offer.id || l.confirmsSent > l.devCard.confirmsAtOffer
    let devices = talosAppHome + "/devices.json"
    let verdict = DialogProofCheck.verify(
      a,
      env: .init(
        pinnedKey: { DeviceKeys.pinnedKey($0, devicesPath: devices) }, nowMs: nowMs, pane: pane, alreadyPressed: sent))
    switch verdict {
    case .no(let why, _): return .nothing(why)
    case .ok(let choice, let label, _):
      l.devCard.proofsUsed = Array((l.devCard.proofsUsed + [used]).suffix(64))
      guard let choice, let label else { return .nothing(.unverified) }  // the open action belongs to the login card
      return pressDevChoice(choice, label, offer, via: "card", launch: &l)
    }
  }

  /// The warning on screen now, if it is still the offered one: the whole warning (one title, one channels line), the same channels, a
  /// highlighted row we know.
  private func offeredWarning(_ offer: DialogOffer) -> DialogMatcher.DevChannels? {
    guard let rows = host.visibleRows(), case .devChannels(let d) = DialogMatcher.classify(rows), d.titleCount == 1, d.channelLineCount == 1,
      ExactText.equal(devSubject(d), offer.subject), let hl = d.highlighted, Self.devCardOptions.contains(hl)
    else { return nil }
    return d
  }

  /// At most one arrow (the row is the other one), then the Enter; every step on a fresh read of the screen, and the Enter only on the signed
  /// choice's own row. A key whose send timed out counts as sent. Nothing is typed while an attached client may be typing.
  func pressDevChoice(_ choice: Int, _ chosen: String, _ offer: DialogOffer, via: String, launch l: inout Launch) -> WorkerManager.AnswerOutcome {
    guard offer.options.indices.contains(choice), ExactText.equal(offer.options[choice], chosen),
      Self.devCardOptions.contains(where: { ExactText.equal($0, chosen) })
    else { return .nothing() }
    for step in 0..<2 {
      if clientsMayBeTyping() { return .blocked(.typing) }
      guard let d = offeredWarning(offer), let here = d.highlighted else { return .nothing() }
      let confirmsIt = ExactText.equal(chosen, Self.devCardOptions[0])
      if ExactText.equal(here, chosen) {
        // the last look, straight before the key
        guard let last = offeredWarning(offer), ExactText.equal(last.highlighted ?? "", chosen) else { return .nothing() }
        if host.sendDialogKey(.enter) == .failed {
          audit("dev_card_send_failed", ["session": l.sessionId, "pid": "\(l.childPid)"])
          return .nothing()
        }
        l.devCard.pressedFor = offer.id
        l.devCard.ownerExit = !confirmsIt
        l.confirmSentAt = clock.now()  // the notice wait counts from the key; the guard never auto-presses behind it
        // the tap on "I am using this for local development" is the owner's confirm; Exit confirms nothing
        if confirmsIt {
          l.devCard.confirmed = true
          recordStartConfirmed(l, ownerConfirmed: true)
        }
        audit("dev_card_answered", ["session": l.sessionId, "choice": "\(choice)", "dialog": offer.id, "via": via])
        emit(.devCardAnswered(dialogId: offer.id, choice: choice))
        return .init(outcome: .pressed, choice: choice, label: chosen)
      }
      guard step == 0 else { return .nothing() }
      let key: DialogKey = ExactText.equal(here, Self.devCardOptions[0]) ? .down : .up  // the two rows: from the first Down, from the other Up
      if host.sendDialogKey(key) == .failed { return .nothing() }
      let until = options.awake() + WorkerManager.echoWait
      var moved = false
      repeat {
        usleep(WorkerManager.echoPoll)
        if let now = offeredWarning(offer), ExactText.equal(now.highlighted ?? "", chosen) { moved = true }
      } while !moved && options.awake() < until
      if !moved { return .nothing() }
    }
    return .nothing()
  }
}
