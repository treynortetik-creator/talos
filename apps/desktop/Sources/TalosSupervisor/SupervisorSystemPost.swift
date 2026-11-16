import Foundation
import TalosDesktopCore

/// The phone line when `talos-app post` can't carry it: no `talos-app`, no thread in `config.json` (it is damaged, or names
/// none), or the post failed. The Mac signs the system row itself with the bridge key (`SystemPost`), to the thread
/// `desktop.json` names, else the one `config.json` names, else `inbox`. A post that timed out is never sent again: it may
/// have gone through.
/// `text` must hold nothing the agent chose (see `postToPhone`): the row is drawn as Talos's own notice.
extension Supervisor {
  @discardableResult
  func postSystemRow(_ text: String, thread: String?, env: [String: String]) -> Bool {
    let home = talosAppHome
    let target = thread.flatMap { WorkerSpec.isThreadId($0) ? $0 : nil } ?? SystemPost.fallbackThread
    guard let key = SystemPost.key(probe.readFile(home + "/bridge.key")) else {
      audit("system_row_skipped", ["why": "no bridge key"])
      return false
    }
    let now = Date(timeIntervalSince1970: options.wallClock() / 1000)
    guard let relay = SystemPost.relayUrl(bridgeEnv: probe.readFile(home + "/bridge.env"), env: env),
      let request = SystemPost.request(relayUrl: relay, key: key, thread: target, text: text, now: now)
    else {
      audit("system_row_skipped", ["why": "no usable relay url"])
      return false
    }
    let probe = self.probe
    let queue = q
    let me = WeakRef(self)
    options.background {  // as the restore: not the shared dispatch pool
      let outcome = probe.send(request)
      queue.sync { me.value?.audit("system_row", ["result": "\(outcome)", "thread": target]) }
    }
    return true
  }
}
