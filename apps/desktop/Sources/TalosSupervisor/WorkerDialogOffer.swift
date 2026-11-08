import Foundation
import TalosDesktopCore

/// Needs-you prompts, the Mac side. A known dialog the pane shows (folder trust, MCP server consent, login) that `DialogReader` can read
/// exactly is put in the worker's `workers.json` entry as `dialog`, so the bridge can make a card the owner answers with a tap. The line
/// the thread has always got ("open Terminals → …") is the fallback, not the first thing: it waits `cardAckWait` (15 s) for the bridge's card file
/// (`workers/<id>/dialog-card.json`, naming the dialog, in any status), and a dialog the bridge has a card for never gets it from the Mac. A dialog
/// the reader refuses, the bypass disclaimer and every unknown question keep the line at once. Answering is `WorkerDialogAnswer.swift`.

/// What the manager keeps about a worker's offered dialog (the offer itself is in `Runtime.entry.dialog`, so it is in `workers.json` and a
/// relaunch finds it).
struct OfferState {
  /// When (awake clock) this copy of the app first saw the offered dialog; nil when none is offered.
  var sinceAwake: Double?
  /// Looks in a row that could not read the dialog the offer is for (a frame caught between two captures); two in a row end the offer.
  var misses = 0
  /// The control ids of the answers already taken, so none is acted on twice.
  var controlsSeen: [String] = []
  /// The dialog id an Enter was sent for: no second Enter for it, whatever arrives.
  var enterSentFor: String?
  /// The screen changed while an offer stood, so what holds still next may be another dialog that looks the same (the owner's Enter in the
  /// pane, a second server): a new sighting, a new id.
  var disturbed = false
  /// "dialog id | signature" of every proof that checked out, so one signed tap is used once, whatever happened to it.
  var proofsUsed: [String] = []
  /// The dialog id Terminals was brought forward for (login): the press-once rule for a dialog that has no Enter. Shared by the card and the popup.
  var openedFor: String?

  /// Whether the Mac pressed (or opened) anything for this dialog id already, by a verified card answer or a popup click. Only this closes
  /// the popup: a result that says nothing was pressed (a forged answer, a phone that is not paired) leaves the one place to answer up.
  func pressed(_ id: String) -> Bool { enterSentFor == id || openedFor == id }
}

extension WorkerManager {
  /// What a worker with a pane can offer (`stopping` still has one).
  static let offerStates: Set<String> = ["starting", "live", "busy", "stopping"]

  /// Once per tick for a worker with a pane, before the dialog is noted. `seen` is the known dialog on a screen that has held still; an
  /// unsettled screen changes nothing (the arrows of an answer redraw it), and a settled one with no dialog ends the offer.
  func syncOffer(_ id: String, rows: [String], seen: DialogMatcher.Screen, settled: Bool) {
    guard let r = rt[id] else { return }
    guard seen.isDialog else {
      if settled, r.entry.dialog != nil {
        endOffer(id)
      } else if !settled, r.entry.dialog != nil, r.offer.sinceAwake != nil {
        rt[id]?.offer.disturbed = true  // an offer this process has verified, and the screen is changing
      }
      return
    }
    // colours too: the reader takes the Select Claude draws, not text that looks like one. A failed capture says nothing.
    let c = run(tmux(id).capturePaneEscaped())
    guard c.ok else { return }
    guard let d = DialogReader.read(rows: rows, escapedRows: TmuxCommands.parseCapture(c.out)) else {
      guard r.entry.dialog != nil else { return }
      rt[id]?.offer.misses += 1
      if (rt[id]?.offer.misses ?? 0) >= 2 { endOffer(id) }
      return
    }
    rt[id]?.offer.misses = 0
    let t = now()
    // The same dialog, still there, and not one the Mac pressed Enter on or saw the screen change under. A record read back from disk after a
    // relaunch is the same only if it equals what the screen shows now; from then on it is this process's own.
    if let o = r.entry.dialog, o.kind == d.kind, ExactText.equal(o.subject, d.subject), ExactText.equal(o.options, d.options),
      !r.offer.disturbed, r.offer.enterSentFor != o.id, r.offer.sinceAwake != nil || (ISOTime.parse(o.seen_at) ?? t + 3600) <= t + 60
    {
      if r.offer.sinceAwake == nil {
        // first look at it by this process: its life is the Mac's, not what the file says
        rt[id]?.offer.sinceAwake = awake()
        if let seen = ISOTime.parse(o.seen_at), (ISOTime.parse(o.expires_at) ?? 0) > seen + options.cardLifetime {
          rt[id]?.entry.dialog?.expires_at = ISOTime.string(seen + options.cardLifetime)
          dirty = true
        }
      }
      if o.cursor != d.cursor {
        rt[id]?.entry.dialog?.cursor = d.cursor
        dirty = true
      }
      return
    }
    rt[id]?.entry.dialog = DialogOffer(
      id: DialogOffer.newId(), kind: d.kind, subject: d.subject, options: d.options, cursor: d.cursor, seen_at: ISOTime.string(t),
      expires_at: ISOTime.string(t + options.cardLifetime))
    rt[id]?.offer.sinceAwake = awake()
    rt[id]?.offer.disturbed = false
    dirty = true
  }

  /// `workers` and the thread's folder in it are folders themselves, not links: nothing is read from or written to a folder that is somewhere else.
  func folderIsReal(_ id: String) -> Bool {
    SafePath.isRealFolder(options.talosHome + "/workers") && SafePath.isRealFolder(dir(id))
  }

  func endOffer(_ id: String) {
    guard rt[id]?.entry.dialog != nil else { return }
    rt[id]?.entry.dialog = nil
    rt[id]?.offer.sinceAwake = nil
    rt[id]?.offer.misses = 0
    rt[id]?.offer.disturbed = false
    dirty = true
  }

  /// Whether the thread's line for the dialog on screen waits: the bridge has a card for it (then it never goes from the Mac), or the
  /// bridge has had `cardAckWait` since the Mac first offered it and has not said so (then it goes, as it always did).
  func lineWaitsForCard(_ id: String) -> Bool {
    guard let r = rt[id], let o = r.entry.dialog else { return false }
    if folderIsReal(id), DialogCardAck.dialogId(path: dir(id) + "/" + DialogCardAck.fileName) == o.id { return true }
    guard let since = r.offer.sinceAwake else { return false }
    return awake() - since < options.cardAckWait
  }
}
