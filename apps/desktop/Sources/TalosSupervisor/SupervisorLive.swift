import Foundation
import TalosDesktopCore

/// Watching a live session on each tick: the screen and its dialogs, the alarms raised to the owner, the start confirmation, and the
/// `agents --json` poll that follows the session id.
extension Supervisor {
  func superviseLive(_ now: Double) {
    guard var l = launch else { return }
    // A screen that could not be read says nothing: not "no dialog". Nothing is read from it (no dialog is raised, cleared or
    // answered), but the start deadline and the agent poll below still run, so a capture that keeps failing cannot hide a start
    // that never settles or a session that has dropped out of the agent list. The notice deadline (it stops the session) does not.
    let read = host.visibleRows()
    let rows = read ?? []
    let unread = read == nil
    let screen = DialogMatcher.classify(rows)
    if case .devChannels(let d) = screen { l.devDialogSeen = d }
    if !unread { mainFirstStart(rows, launch: &l) }
    if !unread { mainSafetyQuestions(rows, launch: &l) }
    if !unread { mainPaneSelect(rows, launch: &l, now: now) }
    if !unread { watchPrompt(rows, launch: &l, now: now) }
    if !unread { mainComputerUse(rows, launch: &l) }
    if !unread { mainUsageLimit(rows, launch: &l) }

    // The warning was answered. The channels notice is no signal: Claude Code 2.1.322 prints none on a resumed start, even with its MCP
    // server connected. What shows it is Claude's input box on a screen with no dialog on it (the warning is gone and Claude is ready for
    // typing), after this start showed the warning. A start that never showed it counts once `noticeWait` has passed.
    let dialogOnScreen: Bool = { if case .devChannels = screen { return true } else { return false } }()
    // The shape check (bottom region, frame, cursor, footer), not a word match on the whole screen: a resumed transcript that quotes the
    // warning, "Run /login" or "Yes, I trust this folder" is conversation. It decides "ready" and the one stop.
    let live = DialogMatcher.liveDialog(rows)
    let warningLive = DialogMatcher.liveDevChannels(rows)
    if l.expectsDevDialog, !l.dialogAnswered, !unread, Self.claudeIsReady(rows: rows, live: live, warningLive: warningLive) {
      if l.devDialogSeen != nil {
        markAnswered(&l, now: now)
      } else if now - l.startedAt >= timings.noticeWait {
        // Ready, but this start never showed the dialog (a CLI change?). Running, nothing recorded.
        l.dialogAnswered = true
        l.answeredAt = now
        phase = .running
        if needsYou == .startStalled { needsYou = nil }
        audit("ready_without_dialog", ["session": l.sessionId])
      }
    }
    checkBridge(&l, now: now)
    watchMain(&l)
    if l.dialogAnswered, phase == .starting { phase = .running }

    // The development-channels warning, at every start (cold or restart): answered when `AutoConfirmGuard` allows it, else held for the owner.
    syncDevCard(onScreen: dialogOnScreen, unread: unread, launch: &l)
    if phase == .starting, l.expectsDevDialog {
      if l.confirmSentAt == nil {
        if case .devChannels(let dialog) = screen {
          // A crash restart counts against the crash loop's cap; a cold start (the owner's reset, the phone's restart) only against its own,
          // and so does the restart after a clean exit, which is no crash.
          let afterCrash = l.kind == .supervisorRestart && !l.afterCleanExit
          switch confirmDevDialog(screen, launch: &l, loop: afterCrash ? loop : coldLoop, now: now) {
          case .sent:
            if afterCrash {
              loop.recordAutoConfirm(now: now)
              emit(.autoConfirmed(sessionId: l.sessionId))  // quiet note; a cold start gets none
            } else { coldLoop.recordAutoConfirm(now: now) }
            recovery.postColdStart = false  // a start that got through its warning has nothing to tell the phone
            l.devRefusal = nil
          case .notSent: break
          case .refused(let why): devDialogRefused(why, dialog: dialog, launch: &l)
          }
        }
      } else if !l.dialogAnswered {
        if case .devChannels(let again) = screen, l.confirmsSent > 0, now - (l.confirmSentAt ?? now) >= timings.tick * 2 {
          // The dialog is back after our one Enter: never press twice.
          raiseNeedsYou(.restartNotConfirmed(.alreadyConfirmedThisStart), key: "twice", launch: &l)
          offerDevDialog(again, launch: &l)
        }
        // The warning still on screen after an Enter and `noticeWait`, with nobody left to answer it: the Enter did not take. This is the
        // only stop. A missing notice is not one (a resumed session prints none), nor is a screen that could not be read (the warning may
        // be gone where we cannot see it; stopping a healthy agent for that would be an action taken on no information). The start
        // deadline below warns instead.
        // Not once the warning has been offered to the owner and no key of his has gone to it: the card, the popup and the phone
        // line all say Main is waiting for him, so it must be there when he clicks. Then the warning stays, with its question.
        let offeredAndUnanswered = l.devCard.offer.map { l.devCard.pressedFor != $0.id } ?? false
        if warningLive, !offeredAndUnanswered, now - (l.confirmSentAt ?? now) >= timings.noticeWait {
          audit("auto_confirm_no_notice", ["session": l.sessionId])
          emit(.confirmFailed)
          launch = l
          beginStop(reason: .noNotice, closeHost: false)
          return
        }
      }
    }

    takeDevAnswer(launch: &l)  // the owner's tap on the card, if one came (it presses; it never seals)
    takePaneAnswer(launch: &l)  // the same for a tool permission or the agent's question (SupervisorPanePrompt.swift)

    // A dialog that has gone from the screen, or been replaced by another, is dealt with: its stall warning is over, and the
    // same kind of dialog appearing again later (a second login expiry) must raise a new one. Only the key of the dialog
    // still showing is kept.
    if !unread {
      let showing = screen.isDialog ? "stall:\(screen.label)" : nil
      l.notifiedScreens = l.notifiedScreens.filter { !$0.hasPrefix("stall:") || $0 == showing }
      // The start-stalled warning is over too once the dev-channel dialog is up: the wait it was about has an answer.
      var over = needsYou == .startStalled && dialogOnScreen
      if case .dialog(let named) = needsYou {
        // the first-start sign-in and API-key needs-you are about the screen `FirstStartScreens` reads, which `DialogMatcher` does not call a dialog
        let first = FirstStartScreens.read(rows)
        if named == Self.signInLabel { over = !(first == .loginMethod || first == .oauthPaste) }
        else if named == Self.apiKeyLabel { over = first != .apiKey }
        else if !screen.isDialog || named != screen.label { over = true }
      }
      // A held question is about the dialog on screen. Once that is gone and the stall was told before, the stall is what is left.
      if needsYouNamesTheDialog, !dialogOnScreen, l.notifiedScreens.contains("start") { over = true }
      // A screen read blank between two dialogs empties the slot while the cold-start question is still held. The dev-channel
      // dialog itself (never another dialog) coming up on an empty slot gets the question back, quietly, before the stall check.
      if needsYou == nil, phase == .starting, l.question != nil, dialogOnScreen { over = true }
      if over { needsYou = Self.alarmUnderneath(l, phase: phase, devDialogOnScreen: dialogOnScreen) }
    }

    // Dialog stall (4.3 step 3): no output for 60 s and a dialog on screen. The generic "a dialog needs you" is the
    // fallback for dialogs nothing above has already named: while the dev-channel dialog is still on screen and the
    // cold-start or refused-restart question about it is held, the stall must not replace it with the vaguer one. A
    // different dialog (trust, consent, login) is not covered by that question, so the stall still raises for it. Nor does the dev-channel
    // dialog stall once our own Enter is on its way and the start is still starting: it is answered, and the screen only has to catch
    // up. A dev-channel dialog that shows up again after the notice (a running session) still stalls.
    // Read only with a dialog up (a tmux call each time); the output that drew the dialog starts its quiet, so a pane found already on a
    // dialog (an attach after a relaunch) waits the full `dialogStall` from the first look.
    if screen.isDialog, let output = host.lastOutputAt(), output != l.outputSeen {
      l.outputSeen = output
      l.outputChangedAt = now
    }
    // (a tool permission or question the Mac offered as a popup and a card is answered there: no stall alarm, no terminal beside it, until the offer has
    // stood unanswered for `paneStallAfter`)
    if screen.isDialog, l.paneOffer == nil || now - l.paneOfferedAt >= timings.paneStallAfter, !(dialogOnScreen && (needsYouNamesTheDialog || (l.confirmSentAt != nil && phase == .starting))), l.outputSeen != nil, now - l.outputChangedAt >= timings.dialogStall {
      raiseNeedsYou(.dialog(screen.label), key: "stall:\(screen.label)", launch: &l)
    }

    // A start that shows nothing Talos recognises must not wait forever. Only when the owner has not already been told
    // something (the cold-start question, a refused restart, a dialog) that explains why it is still starting. A held
    // question about the dev-channel dialog explains the wait only while that dialog is still on screen.
    if phase == .starting, needsYou == nil || (needsYouNamesTheDialog && !dialogOnScreen && !unread), now - l.startedAt >= timings.startWait {
      raiseNeedsYou(.startStalled, key: "start", launch: &l)
    }

    launch = l

    if now - lastAgentsPollAt >= timings.agentsPoll, !agentsPollInFlight {
      lastAgentsPollAt = now
      if config.session.conversationSeen != l.sessionId { noteConversation(l.sessionId, folder: l.agentDir) }
      pollAgents()
    }
  }

  /// What the one `needsYou` slot held before a dialog's warning took it. The alarms are raised once, so their keys outlive the
  /// warning: when the dialog is over and the cause still stands, the alarm comes back (nothing is told twice). The cold-start or
  /// refused-restart question comes back, with its own reason, while the dev-channel dialog it is about is on screen again.
  static func alarmUnderneath(_ l: Launch, phase: Phase, devDialogOnScreen: Bool) -> NeedsYou? {
    if devDialogOnScreen, phase == .starting, let q = l.question { return q }
    if l.notifiedScreens.contains("stuck") { return .stuck }
    if l.notifiedScreens.contains("bridge"), !l.bridgeSeenLive, let a = l.bridgeAlarm { return a }
    if l.notifiedScreens.contains("start"), phase == .starting { return .startStalled }
    return nil
  }

  /// The owner has already been told what to do about the dialog on screen (press Enter, or why Talos did not).
  private var needsYouNamesTheDialog: Bool {
    switch needsYou {
    case .confirmColdStart, .restartNotConfirmed: return true
    default: return false
    }
  }

  /// The needs-you slot holds a dialog that is never to be answered (`DialogMatcher.Screen.answerless`).
  static func holdsAnswerless(_ n: NeedsYou?) -> Bool {
    if case .dialog(let label)? = n { return DialogMatcher.Screen.answerless(label: label) }
    return false
  }

  func raiseNeedsYou(_ n: NeedsYou, key: String, launch l: inout Launch) {
    guard !l.notifiedScreens.contains(key) else { return }
    l.notifiedScreens.insert(key)
    needsYou = n
    switch n {
    case .confirmColdStart, .restartNotConfirmed: l.question = n
    default: break
    }
    audit("needs_you", ["why": key])
    emit(.needsYou(n))
    if config.openTerminalOnDialog, Self.opensTerminal(for: n) { emit(.openTerminal) }
    // the sign-in card shows only for the real auth screen (the login hint under a live box, or a first-start sign-in screen), never for
    // the words "Run /login" somewhere on a conversation (`signInIsLive`)
    if case .dialog(let label) = n, Self.isSignIn(label: label), signInIsLive() { emit(.openSignIn) }
  }

  /// Whether a running session belongs to the folder the config names now. After a switch of folder nothing restarts, so the old
  /// session goes on, and what it reports or has confirmed is the old folder's: never written into the new folder's setup.
  private func isForConfiguredFolder(_ l: Launch) -> Bool {
    PathUtil.canonical(l.agentDir) == PathUtil.canonical(config.expandedAgentDir(home: options.home))
  }

  /// This start's session is the confirmed one (the checklist's "first start confirmed"), unless it is for another folder. Only the
  /// owner's click on the Mac popup (`ownerConfirmed`) stores and seals the launch fingerprint the auto-accept compares with; an auto-accept or a plain Enter in the pane never does.
  @discardableResult
  func recordStartConfirmed(_ l: Launch, ownerConfirmed: Bool = false) -> Bool {
    guard isForConfiguredFolder(l) else { return false }
    config.session.id = l.sessionId
    config.session.confirmedAt = ISO8601DateFormatter().string(from: Date())
    if ownerConfirmed, !LaunchSeal.confirm(&config, fingerprint: l.fingerprint, parts: l.parts, trust: options.launchTrust) {
      audit("launch_seal_unavailable", ["session": l.sessionId])  // no key could be used: stored unsealed, so the next start asks again
    }
    saveConfig()
    return true
  }

  /// This start's dev-channels warning is answered (the screen shows something else now): running, and the bridge's window starts.
  private func markAnswered(_ l: inout Launch, now: Double) {
    l.dialogAnswered = true
    l.answeredAt = now
    phase = .running
    // The start-stalled alarm was about this very wait, which is over: a healthy running session must not keep it. A question held for the
    // owner about the dialog is answered too.
    if needsYou == .startStalled || needsYouNamesTheDialog { needsYou = nil }
    if l.confirmsSent == 0, l.confirmSentAt == nil, !l.devCard.confirmed {
      recordHumanConfirm(&l, now: now)  // an Enter at the pane
    } else if !l.devCard.confirmed {  // (a tap on the card or a popup click already recorded its own confirm)
      audit("auto_confirm_ok", ["session": l.sessionId])
      if config.session.confirmedAt == nil { recordStartConfirmed(l) }  // the first-start row of the checklist
    }
    adoptReportedIdIfNeeded(&l)
  }

  private func recordHumanConfirm(_ l: inout Launch, now: Double) {
    // a plain Enter in the pane confirms this start only: it can be anyone with tmux, so it seals nothing (only a click on the Mac popup does)
    guard l.devDialogSeen != nil, recordStartConfirmed(l) else { return }
    audit("human_confirm", ["session": l.sessionId])
    emit(.humanConfirmed(sessionId: l.sessionId))
  }

  private func pollAgents() {
    guard let l = launch, let claude = resolvedClaude ?? resolveClaude(env: launchEnv()) else { return }
    let env = launchEnv()
    let pid = l.childPid
    agentsPollInFlight = true
    let probe = self.probe
    let queue = q
    let me = WeakRef(self)
    pollQ.async {
      let entries = probe.agents(claude: claude, env: env)
      queue.async { me.value?.handleAgents(entries, pid: pid) }
    }
  }

  private func handleAgents(_ entries: [AgentEntry]?, pid: Int32) {
    agentsPollInFlight = false
    guard var l = launch, l.childPid == pid, phase == .running || phase == .starting else { return }
    recordHolders(&l)
    agentActivity = nil
    if let entries {
      if let e = AgentsList.interactive(entries, pid: pid) {
        agentActivity = e.status
        l.agentsMisses = 0
        // It's listed again: no longer stuck, whatever the slot holds now (a dialog may have taken it).
        if needsYou == .stuck { needsYou = nil }
        l.notifiedScreens.remove("stuck")
        if let sid = e.sessionId, sid != l.sessionId {
          l.reportedSessionId = sid
          if l.dialogAnswered || !l.expectsDevDialog { adoptReportedIdIfNeeded(&l) }
        }
      } else if phase == .running {
        l.agentsMisses += 1
        // Main on a screen that is never to be answered (the usage limit, the computer-use dialog) has dropped out of the list because of
        // it: that is what the owner is told, and Terminals is not raised. The alarm can come once the screen is gone.
        if l.agentsMisses >= timings.hangPolls, !Self.holdsAnswerless(needsYou) { raiseNeedsYou(.stuck, key: "stuck", launch: &l) }
      }
    }
    launch = l
    publish()
  }

  /// `agents --json` reports a different id than we launched with (4.4): follow it, after the notice, and move the
  /// human confirmation with it only if this start was confirmed.
  private func adoptReportedIdIfNeeded(_ l: inout Launch) {
    guard let sid = l.reportedSessionId, sid != l.sessionId, ResumeRewrite.isUUID(sid), isForConfiguredFolder(l) else { return }
    let old = l.sessionId
    var s = config.session
    let keepConfirm = s.confirmedAt != nil && s.id == old && (l.dialogAnswered || !l.expectsDevDialog)
    s.previousIds.removeAll { $0 == old }
    s.previousIds.append(old)
    if s.previousIds.count > 5 { s.previousIds.removeFirst(s.previousIds.count - 5) }
    s.id = sid
    if !keepConfirm {
      s.confirmedAt = nil
      s.confirmedCliVersion = nil
    }
    config.session = s
    l.sessionId = sid
    host.setMarker("talos_session", sid)
    saveConfig()
    audit("session_id_changed", ["from": old, "to": sid])
  }
}
