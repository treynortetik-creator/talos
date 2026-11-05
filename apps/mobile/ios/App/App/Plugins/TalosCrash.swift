import Capacitor
import Foundation
import MetricKit
import TalosCrashCore

/// Keeps the system's crash and hang reports until the page asks for them (docs/ERRORS.md). MetricKit hands a diagnostic
/// payload to a subscriber, possibly while the web view is not running (or after the app was killed), so the summaries wait
/// in a small file in Application Support. Nothing is sent from here: the page drains them and sends them like any other
/// problem report, through the relay, where the owner's signed-in session is the only credential.
final class TalosCrashStore {
    static let shared = TalosCrashStore()
    private let lock = NSLock()
    private let url: URL = {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("talos-crash-queue.json")
    }()

    private func read() -> [CrashSummary] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        return (try? JSONDecoder().decode([CrashSummary].self, from: data)) ?? []
    }

    func add(_ new: [CrashSummary]) {
        guard !new.isEmpty else { return }
        lock.lock(); defer { lock.unlock() }
        let merged = CrashCore.appending(new, to: read())
        if let data = try? JSONEncoder().encode(merged) { try? data.write(to: url, options: [.atomic, .completeFileProtection]) }
    }

    /// Hands over everything waiting and forgets it. A report the page fails to send is the page's to keep (its own queue).
    func drain() -> [CrashSummary] {
        lock.lock(); defer { lock.unlock() }
        let all = read()
        try? FileManager.default.removeItem(at: url)
        return all
    }
}

final class TalosCrashSubscriber: NSObject, MXMetricManagerSubscriber {
    static let shared = TalosCrashSubscriber()

    /// Called once from the app delegate at launch. A report is taken when the system delivers it (`didReceive`). The past
    /// payloads are not read here: Apple's documentation says they leave out earlier launches, so reading them adds nothing.
    /// Whether that read ever sent an old crash twice was not seen on a phone.
    func start() {
        MXMetricManager.shared.add(self)
    }

    func didReceive(_ payloads: [MXDiagnosticPayload]) { take(payloads) }

    private func take(_ payloads: [MXDiagnosticPayload]) {
        for p in payloads { TalosCrashStore.shared.add(CrashCore.summaries(fromPayloadJSON: p.jsonRepresentation())) }
    }
}

@objc(TalosCrashPlugin)
public class TalosCrashPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TalosCrashPlugin"
    public let jsName = "TalosCrash"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "drain", returnType: CAPPluginReturnPromise)
    ]

    /// `{ summaries: [...] }`, oldest first, and the list is empty from then on. Refused outside the relay's own page, like
    /// every plugin of the app (TalosPluginGate).
    @objc func drain(_ call: CAPPluginCall) {
        guard TalosPluginGate.allows(bridge) else { return call.reject("not allowed here") }
        let summaries = TalosCrashStore.shared.drain()
        guard let data = try? JSONEncoder().encode(summaries),
              let json = try? JSONSerialization.jsonObject(with: data) as? [Any] else { return call.resolve(["summaries": []]) }
        call.resolve(["summaries": json])
    }
}
