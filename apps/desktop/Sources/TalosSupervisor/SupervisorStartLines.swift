import Foundation
import TalosDesktopCore

/// Row 12 of "every prompt shows up in the app": Main's start that stalls, a resume that fails and a start that cannot be made are a plain
/// line in the default thread, through `postToPhone` (`talos-app post`, run by this app, so Main's bridge is not needed; the Mac's own system
/// row when that is not possible). The Mac's menu notice stays beside it. No button rides on the line: the phone's restart, `restart_main`
/// and a card tap all go through Main's bridge, and that is what is not up here. The line names the Mac's menu item instead.
extension Supervisor {
  /// The events that are row 12's, from `emit` (the one place every event passes): a stall, a resume that failed, a start that was not made.
  func postStartLineIfDue(_ e: Event) {
    switch e {
    case .needsYou(.startStalled):
      // the real wait (a pause for an unanswered tmux is part of it), not the configured one: "after 12 minutes", not "after 2"
      let waited = launch.map { clock.now() - $0.startedAt } ?? timings.startWait
      postStartLine(.startStalled) { SupervisorNotice.startStalledLine(agentName: $0, waited: waited) }
    case .resumeFailed: postStartLine(.resumeFailed) { SupervisorNotice.resumeFailedLine(agentName: $0) }
    case .stopped(let r):
      if case .startFailed = r, r.startDetail != SupervisorNotice.anotherInstanceDetail {
        postStartLine(.couldNotStart) { SupervisorNotice.couldNotStartLine(agentName: $0) }
      }
    default: break
    }
  }

  /// One line of `kind`, spaced like the request lines (at most one per `MainRestartCheck.phoneLineGap`, one post at a time) on this
  /// gate's own clock. A line that may not go is dropped and the audit log says so.
  func postStartLine(_ kind: MainRestartCheck.PhoneLine, _ text: (String?) -> String) {
    // a restart the owner asked for that then stalls or fails already gets its own line (`followRequest`): two voices would disagree
    guard recovery.restartCheck.following == nil else { return audit("start_line_skipped", ["kind": kind.rawValue, "why": "restart_request"]) }
    guard recovery.startLines.take(kind, awake: options.awake()) else {
      audit("start_line_dropped", ["kind": kind.rawValue, "why": recovery.startLines.inFlight ? "in_flight" : "spaced"])
      return
    }
    audit("start_line_post", ["kind": kind.rawValue])
    let me = WeakRef(self)
    postToPhone(text, done: { me.value?.recovery.startLines.finished() })
  }
}
