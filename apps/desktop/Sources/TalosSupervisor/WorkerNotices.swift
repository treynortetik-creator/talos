import Foundation
import TalosDesktopCore

/// Option C: what a worker's pane says to the owner. A dialog on it (`noteScreen`), the one line the thread gets (`sendNotice`,
/// with its record `notice.json` and debounce), and a pointer held back by the owner's draft (`noteHeldPointer`). Split out of
/// `WorkerManager` so neither file passes the size limit; nothing here is called from anywhere else.
extension WorkerManager {
  /// thread id → the dialog its pane shows now, for every worker waiting on the owner.
  public func needsYou() -> [String: String] {
    queue.sync { rt.compactMapValues { waitingOn($0) } }
  }

  /// What a worker waits on the owner for: the dialog on its pane, or, after a while, text in its input box that holds the pointer.
  func waitingOn(_ r: Runtime) -> String? {
    if let p = r.needsYouPrompt { return p }
    if let since = r.draftSince, awake() - since >= options.draftNoticeAfter { return WorkerNotice.draftKind }
    return nil
  }

  // MARK: dialogs on worker panes

  /// What the pane shows now: a dialog sets the worker's needs-you flag and posts one line into its thread; a screen without
  /// one clears the flag. Runs for every worker, in every state that has a pane. Nothing is ever typed into a dialog.
  func noteScreen(_ id: String, _ scr: DialogMatcher.Screen, settled: Bool) {
    guard var r = rt[id] else { return }
    guard scr.isDialog else {
      let hadFlag = r.needsYouPrompt != nil
      if hadFlag {
        r.needsYouPrompt = nil
        r.dialogSinceAwake = nil
        r.dlg.reset()
      }
      // A relaunch (or an adopt) forgets which dialog was open, but notice.json still says it was. The first look at this
      // worker's screen settles it: no dialog now, so no record stays open. Only a screen that has held still says so: a dialog
      // that was just redrawn reads as none for a moment.
      if hadFlag || (settled && !r.recordsChecked) {
        r.recordsChecked = true
        rt[id] = r
        closeNoticeRecord(id)
      } else {
        rt[id] = r
      }
      return
    }
    r.recordsChecked = true
    let prompt = WorkerNotice.promptName(scr)
    if r.needsYouPrompt != prompt {
      // a new dialog (or the first): one notice for it
      r.needsYouPrompt = prompt
      if r.dialogSinceAwake == nil { r.dialogSinceAwake = awake() }
      r.dlg.reset()
      rt[id] = r
      emit(.needsYou(thread: id, prompt: prompt))
    } else {
      rt[id] = r
    }
    sendNotice(id, \.dlg, kind: prompt, text: WorkerNotice.line(threadName: threadName(id), screen: scr))
  }

  func threadName(_ id: String) -> String {
    let names = SessionSwitcher.names(fromConfig: FileManager.default.contents(atPath: configJson))
    return names[id] ?? id
  }

  // The notice record: `workers/<id>/notice.json`, kind → when it was sent (wall clock) and whether that dialog (or hold) is
  // still open. It makes a notice at-most-once per kind per `noticeDebounce`, and survives a relaunch: the same still-open
  // dialog is never announced twice.
  struct NoticeRecord: Codable { var at: Double; var open: Bool }

  func readNotices(_ id: String) -> [String: NoticeRecord] {
    FileManager.default.contents(atPath: dir(id) + "/notice.json").flatMap { try? JSONDecoder().decode([String: NoticeRecord].self, from: $0) } ?? [:]
  }

  func writeNotices(_ id: String, _ m: [String: NoticeRecord]) {
    guard let d = try? JSONEncoder().encode(m) else { return }
    try? AtomicFile.write(d, to: dir(id) + "/notice.json", mode: 0o600)
  }

  func closeNoticeRecord(_ id: String) {
    var m = readNotices(id)
    guard m.values.contains(where: \.open) else { return }
    for k in m.keys { m[k]?.open = false }
    writeNotices(id, m)
  }

  /// Already announced: this kind is still open from before a relaunch, or one of this kind went out lately.
  func noticeSuppressed(_ id: String, kind: String, at t: Double) -> Bool {
    guard let rec = readNotices(id)[kind] else { return false }
    if rec.open { return true }
    return rec.at <= t + 60 && t - rec.at < options.noticeDebounce  // a clock set back does not hold a notice for ever
  }

  /// One line into the thread, once per episode (`state`), through `postNotice`. A clear failure is retried (three tries, then
  /// the Mac says so); a timeout is not (it may have been sent); a repeat of the same kind inside the debounce window is not sent.
  func sendNotice(_ id: String, _ state: WritableKeyPath<Runtime, NoticeState>, kind: String, text: String) {
    guard let r = rt[id], !r[keyPath: state].sent, !r[keyPath: state].inFlight, awake() >= r[keyPath: state].retryAt else { return }
    if noticeSuppressed(id, kind: kind, at: now()) {
      rt[id]?[keyPath: state].sent = true
      return
    }
    guard let post = postNotice else {
      rt[id]?[keyPath: state].sent = true
      return
    }
    rt[id]?[keyPath: state].inFlight = true
    // written before the post: a crash or relaunch in the middle can't make a second one
    var m = readNotices(id)
    m[kind] = NoticeRecord(at: now(), open: true)
    writeNotices(id, m)
    let episode = r[keyPath: state].episode
    // an own thread: a post is a child process that can take a while, and a busy dispatch pool (every blocked read holds one
    // of its threads) has been measured to hold a notice back for seconds
    Thread.detachNewThread { [weak self] in
      let outcome = post(id, text)
      self?.queue.async {
        guard let self else { return }
        // A clear failure sent nothing: the debounce slot is given back whether or not the episode has moved on, so the next
        // dialog of this kind isn't held back by a notice that never went.
        if outcome == .failed {
          var m = self.readNotices(id)
          m[kind] = nil
          self.writeNotices(id, m)
        }
        guard self.rt[id]?[keyPath: state].episode == episode else { return }  // answered or replaced meanwhile: nothing to track
        self.rt[id]?[keyPath: state].inFlight = false
        switch outcome {
        case .sent, .unknown:
          // a timeout may have been sent: not retried, so it can't go twice
          self.rt[id]?[keyPath: state].sent = true
        case .failed:
          let n = (self.rt[id]?[keyPath: state].attempts ?? 0) + 1
          self.rt[id]?[keyPath: state].attempts = n
          if n >= 3 {
            self.rt[id]?[keyPath: state].sent = true
            self.emit(.noticeFailed(thread: id))
          } else {
            self.rt[id]?[keyPath: state].retryAt = self.awake() + self.options.noticeRetry
          }
        }
      }
    }
  }

  /// A pointer held back by a draft in Claude's input box is not silent: after `draftNoticeAfter` the thread gets one line, and
  /// the Terminals window shows the thread as Needs you until the box is clear.
  func noteHeldPointer(_ id: String, held: Bool) {
    guard rt[id] != nil else { return }
    if !held {
      if rt[id]?.draftSince != nil {
        rt[id]?.draftSince = nil
        rt[id]?.held.reset()
        closeNoticeRecord(id)
      }
      return
    }
    if rt[id]?.draftSince == nil { rt[id]?.draftSince = awake() }
    guard let since = rt[id]?.draftSince, awake() - since >= options.draftNoticeAfter else { return }
    sendNotice(id, \.held, kind: WorkerNotice.draftKind, text: WorkerNotice.draftLine(threadName: threadName(id)))
  }
}
