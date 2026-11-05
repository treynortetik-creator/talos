import Foundation

/// How one Reply or Approve press from a notification ends, with iOS and the network behind closures so a test can drive it.
///
/// Three rules live here and nowhere else:
/// 1. A press ends exactly once: the relay's answer, a local failure, or iOS running out of background time, whichever comes
///    first. The system's completion handler is called once, and a late answer posts nothing.
/// 2. Nothing is shown as sent that was not accepted. Only a 2xx answer ends with no failure notice; a refusal, an answer the
///    phone cannot read, or no answer after one retry ends with a notice that says what to do.
/// 3. A press that may have gone through but was cut off by iOS says so, instead of vanishing.
public final class QuickActRun: @unchecked Sendable {
    /// Posts a failure notice (its text never holds the message), then calls the closure.
    public typealias NotifyFailure = (_ message: String, _ then: @escaping () -> Void) -> Void
    /// Sends the body once and reports the HTTP status (nil when no answer came) and the relay's `error` field.
    public typealias Transport = (_ body: Data, _ reply: @escaping (_ status: Int?, _ code: String?) -> Void) -> Void
    /// Runs the closure after a short wait.
    public typealias RetryLater = (_ run: @escaping () -> Void) -> Void

    public static let outOfTimeMessage = "Talos couldn't confirm that went through. Open Talos to check."
    public static let noSignalMessage = "No signal, so Talos couldn't send that. Open Talos and try again."

    private let notifyFailure: NotifyFailure
    private let complete: () -> Void
    private let endBackgroundTask: () -> Void
    private let lock = NSLock()
    private var settled = false

    public init(notifyFailure: @escaping NotifyFailure, complete: @escaping () -> Void, endBackgroundTask: @escaping () -> Void) {
        self.notifyFailure = notifyFailure
        self.complete = complete
        self.endBackgroundTask = endBackgroundTask
    }

    private func claim() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if settled { return false }
        settled = true
        return true
    }

    /// Ends the press. `message` nil = accepted. Only the first call counts.
    public func conclude(_ message: String?) {
        guard claim() else { return }
        if let message {
            notifyFailure(message) { [self] in complete(); endBackgroundTask() }
        } else {
            complete(); endBackgroundTask()
        }
    }

    /// iOS is about to suspend the app with the send unconfirmed.
    public func timeExpired() {
        if claim() {
            notifyFailure(Self.outOfTimeMessage) {}
            complete()
        }
        endBackgroundTask()
    }

    /// One try, and one retry with the same body if the outcome says a retry is worth it.
    public func send(body: Data, transport: @escaping Transport, retryLater: @escaping RetryLater) {
        attempt(0, body, transport, retryLater)
    }

    private func attempt(_ n: Int, _ body: Data, _ transport: @escaping Transport, _ retryLater: @escaping RetryLater) {
        transport(body) { [self] status, code in
            switch RichPush.outcome(status: status, code: code) {
            case .done: conclude(nil)
            case .retry where n < 1: retryLater { self.attempt(n + 1, body, transport, retryLater) }
            case .retry: conclude(Self.noSignalMessage)
            case let .failed(message): conclude(message)
            }
        }
    }
}
