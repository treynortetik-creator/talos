import BridgeGuard
import Foundation
import TalosRelayCore

/// What the owner chose when the Mac's key changed.
enum RepinChoice: Equatable {
    case accept, decline, remove
}

/// Runs the attests of one web view controller and writes their results into its one `RelayTrust` (BYOR phase 4b,
/// docs/specs/BYOR-phase4-frame.md sections 4 to 6). One check at a time; none runs while the relay is `failed`. It never reads a page, a
/// deep link or a plugin argument: the only thing a page can do here is ask for another check, through `recheckFromPage()`.
@MainActor
final class AttestCoordinator {
    enum Trigger: Equatable { case launch, foreground, network, timer, page, retry }

    private let trust: RelayTrust
    private let runner: AttestRunning
    private let cookie: () async -> String?
    private let store: () -> RelayStore?
    private let confirmRepin: (_ host: String, _ newFP: String) async -> RepinChoice
    private let now: () -> Date
    private let changed: () -> Void
    private let remove: () -> Void
    private var schedule = AttestSchedule()
    private var stopped = false
    /// The new key the owner already said no to: a timer or a foreground does not ask again; only Retry does.
    private var declinedFP: String?
    /// The owner accepted a new key while another check was running, so the fresh check against it could not start. It runs once, when
    /// the running check ends (a check that started before the accept still pins the old key).
    private var freshCheckPending = false

    /// The pairing this coordinator checks. `bridgeFp` moves when the owner accepts a rotation.
    private(set) var profile: RelayProfile

    init(
        profile: RelayProfile, trust: RelayTrust, runner: AttestRunning,
        cookie: @escaping () async -> String?, store: @escaping () -> RelayStore?,
        confirmRepin: @escaping (_ host: String, _ newFP: String) async -> RepinChoice,
        now: @escaping () -> Date = Date.init, changed: @escaping () -> Void = {}, remove: @escaping () -> Void = {}
    ) {
        self.profile = profile
        self.trust = trust
        self.runner = runner
        self.cookie = cookie
        self.store = store
        self.confirmRepin = confirmRepin
        self.now = now
        self.changed = changed
        self.remove = remove
    }

    var isRunning: Bool { schedule.isRunning }

    /// The controller is going away: nothing more is written into the trust object.
    func stop() { stopped = true }

    /// The page asked (`TalosRelay.recheck()`). It adds a check, never skips one and never sets a result: one at a time, 30 s apart,
    /// and only while the relay is `.pass`. A call that is not allowed does no network call.
    func recheckFromPage() {
        guard trust.state == .pass else { return }
        Task { await run(.page) }
    }

    func run(_ trigger: Trigger) async {
        guard !stopped else { return }
        if case .failed = trust.state { return }
        if trigger == .page, trust.state != .pass { return }
        guard schedule.begin(at: now(), fromPage: trigger == .page) else { return }
        // A check that begins now reads the pin as it is now: it is the fresh one, if one was waiting.
        freshCheckPending = false
        // The slot is given back once, by whichever comes first: the end of this check, or the moment the owner is asked about a key
        // change (so an alert that never shows cannot hold up Retry, the triggers and the hard-block refresh).
        var held = true
        func release() {
            if held {
                held = false
                schedule.end()
            }
        }
        defer { release() }

        let session = await cookie()
        let outcome = await runner.run(
            origin: profile.origin, relayID: profile.id, pinnedFP: profile.bridgeFp, cookie: session, context: .reconnect)
        guard !stopped else { return }
        switch outcome {
        case .verdict(.pass):
            declinedFP = nil
            trust.markPass()
            let verifiedAt = trust.lastVerifiedAt
            save { $0.lastVerifiedAt = verifiedAt; $0.attestFailed = false }
        case let .verdict(.repin(newFP)):
            await handleRepin(newFP, explicit: trigger == .retry, release: release)
        case let .verdict(.fail(reason)):
            trust.markFailed(reason.rawValue)
            save { $0.attestFailed = true }
        case let .unreachable(why):
            trust.markUnverified(UnverifiedReason(rawValue: why.rawValue) ?? .badAnswer)
        }
        guard !stopped else { return }
        trust.settle()
        changed()
        if freshCheckPending, !stopped {
            release()
            await run(.retry)
        }
    }

    /// The Mac's key changed through a rotation the old key signed. Every re-pin, signed or not, needs a blocking native confirm
    /// that shows the host. Until the owner accepts, the relay stays unverified and nothing is saved. Accepting saves the new key and
    /// then runs a FRESH check against it: the answer the key change came with may be hours old when the owner taps, so it is never
    /// stamped as a pass.
    private func handleRepin(_ newFP: String, explicit: Bool, release: () -> Void) async {
        trust.markUnverified(.keyChanged)
        // A check that started before the owner accepted answers with the key that is pinned by now: the next check settles it.
        if newFP == profile.bridgeFp { return trust.markUnverified(.checking) }
        if declinedFP == newFP, !explicit { return }
        trust.settle()
        changed()
        release()
        // Another check may see a different new key while this question is on screen: the prompt answers that second ask "no" at once.
        // That is safe: a "no" changes no pin and passes nothing, it only leaves the relay unverified (and remembers the key, so a timer
        // does not ask again; Retry or yet another key does). The owner is never asked two things at the same time.
        let choice = await confirmRepin(profile.label, newFP)
        guard !stopped else { return }
        switch choice {
        case .accept:
            guard save({ $0.bridgeFp = newFP }) else { return trust.markUnverified(.saveFailed) }
            profile.bridgeFp = newFP
            declinedFP = nil
            trust.markUnverified(.checking)
            freshCheckPending = true
            await run(.retry)
        case .decline:
            declinedFP = newFP
        case .remove:
            declinedFP = newFP
            remove()
        }
    }

    /// Saves a change to this pairing's stored profile, by its key id. False when it could not be saved.
    @discardableResult
    private func save(_ change: (inout RelayProfile) -> Void) -> Bool {
        guard let store = store() else { return false }
        do {
            return try store.update(keyId: profile.keyId, change)
        } catch {
            return false
        }
    }
}
