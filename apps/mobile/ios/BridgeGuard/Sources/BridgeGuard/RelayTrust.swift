import Foundation

/// Why the Mac could not be confirmed (an unsigned word of the relay, or no word at all). Plain words for each are in the app.
public enum UnverifiedReason: String, Sendable, Equatable {
    /// The first check of this launch has not answered yet.
    case checking
    case network
    case macOffline = "mac_offline"
    case unsupported = "attest_unsupported"
    case macTimeout = "attest_timeout"
    case rateLimited = "rate_limited"
    case badAnswer = "bad_answer"
    /// The Mac's key changed and the owner did not accept the new one.
    case keyChanged = "key_changed"
    case saveFailed = "save_failed"
}

/// How far the app trusts that the relay it is on answers for the owner's Mac (docs/specs/BYOR-phase4-frame.md section 5).
/// Every guard method takes the state, so adding a case here fails to compile until each one says what it allows.
public enum RelayTrustState: Sendable, Equatable {
    /// A fresh attest was signed by the pinned key.
    case pass
    /// The Mac did not answer (or the owner has not accepted its new key). Native features are off; the page is read-only.
    case unverified(lastVerified: Date?, reason: UnverifiedReason)
    /// The relay answered with the wrong key, a bad signature, a bad shape or a bad chain. Nothing loads.
    case failed(reason: String)
    /// 24 hours (`RelayTrust.hardBlockAfter`) without a verified attest. Nothing loads.
    case hardBlock(lastVerified: Date?)

    /// Plugin calls, camera, microphone, sharing and prompt() messages.
    public var allowsNativeFeatures: Bool {
        switch self {
        case .pass: return true
        case .unverified, .failed, .hardBlock: return false
        }
    }

    /// Whether the web view may show the relay's page (read-only unless `.pass`).
    public var loadsPage: Bool {
        switch self {
        case .pass, .unverified: return true
        case .failed, .hardBlock: return false
        }
    }
}

/// The one shared reference to the current trust state. The view controller makes it once per relay and injects the SAME object into
/// every site that guards native access (the bridge handler, the share handler, the navigation gate, the plugin gate). Each site
/// reads `state` when a call arrives and hands it to the `BridgeGuard` method, which stays a pure value.
///
/// The time of the last verified attest is the only thing that counts toward the 24-hour limit; it is renewed by every pass.
/// `state` is worked out when it is read, so a window that ran out while nothing was checking still reads `.hardBlock`.
public final class RelayTrust: @unchecked Sendable {
    /// True since the app checks the Mac (BYOR phase 4b: pairing needs a passing attest, and every reconnect is checked).
    /// scripts/testflight.sh refuses to ship while it is false, because the app would trust any scanned relay without verifying the Mac.
    public static let verifiesTheMac = true

    /// 24 hours from the last verified attest (owner decision, 2026-11-17).
    public static let hardBlockAfter: TimeInterval = 24 * 3600

    private enum Phase { case pass, unverified(UnverifiedReason), failed(String) }

    private let lock = NSLock()
    private let now: () -> Date
    private var phase: Phase
    private var lastVerified: Date?
    private var didSettle: Bool
    private let windowApplies: Bool

    /// `.pass` as the starting state is for a page that is not a paired relay (a development build's compiled-in address) and for
    /// tests; a paired relay starts `.unverified(…, .checking)` and reaches `.pass` only through `markPass()`.
    /// `hasWindow: false` is only for that page that is no paired relay: it has no key and no attest, so no 24 hours to count.
    public init(_ state: RelayTrustState = .pass, lastVerified: Date? = nil, hasWindow: Bool = true, now: @escaping () -> Date = Date.init) {
        self.now = now
        self.windowApplies = hasWindow
        self.lastVerified = lastVerified
        switch state {
        case .pass: phase = .pass
        case let .unverified(_, reason): phase = .unverified(reason)
        case let .failed(reason): phase = .failed(reason)
        case .hardBlock: phase = .unverified(.checking)
        }
        if case .pass = state { didSettle = true } else { didSettle = false }
        if case let .unverified(lv, _) = state { self.lastVerified = lv ?? lastVerified }
        if case let .hardBlock(lv) = state { self.lastVerified = lv ?? lastVerified }
    }

    public var state: RelayTrustState {
        lock.lock()
        defer { lock.unlock() }
        return effective()
    }

    /// The time of the last verified attest, nil when none was ever made.
    public var lastVerifiedAt: Date? {
        lock.lock()
        defer { lock.unlock() }
        return lastVerified
    }

    /// True once the first check of this launch has answered (any answer).
    public var settled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return didSettle
    }

    /// The web view may load a relay page: the first check has answered and the state still shows pages.
    public var allowsPageLoad: Bool {
        lock.lock()
        defer { lock.unlock() }
        return didSettle && effective().loadsPage
    }

    /// A verified attest: the state is `.pass` and the 24 hours count from now. A failed relay stays failed.
    public func markPass() {
        lock.lock()
        defer { lock.unlock() }
        if case .failed = phase { return }
        phase = .pass
        lastVerified = now()
    }

    /// The Mac could not be confirmed. The last verified time is kept. A failed relay stays failed.
    public func markUnverified(_ reason: UnverifiedReason) {
        lock.lock()
        defer { lock.unlock() }
        if case .failed = phase { return }
        phase = .unverified(reason)
    }

    /// The relay answered, and the answer is wrong. Sticky: only removing the relay clears it.
    public func markFailed(_ reason: String) {
        lock.lock()
        defer { lock.unlock() }
        phase = .failed(reason)
    }

    /// The first check of this launch has answered.
    public func settle() {
        lock.lock()
        defer { lock.unlock() }
        didSettle = true
    }

    /// Seconds from `now` until the 24 hours from `lastVerified` run out, or nil when they already have (or there is no time): the
    /// moment to refresh the screen, so the block shows on time even when nothing else asks.
    public static func secondsUntilHardBlock(lastVerified: Date?, now: Date) -> TimeInterval? {
        guard let lastVerified else { return nil }
        let left = lastVerified.addingTimeInterval(hardBlockAfter).timeIntervalSince(now)
        let age = now.timeIntervalSince(lastVerified)
        return age >= 0 && left > 0 ? left : nil
    }

    private func expired() -> Bool {
        guard windowApplies else { return false }
        guard let lv = lastVerified else { return true }
        let age = now().timeIntervalSince(lv)
        return age < 0 || age >= Self.hardBlockAfter  // a time in the future counts as expired
    }

    private func effective() -> RelayTrustState {
        switch phase {
        case let .failed(reason): return .failed(reason: reason)
        case .pass: return expired() ? .hardBlock(lastVerified: lastVerified) : .pass
        case let .unverified(reason): return expired() ? .hardBlock(lastVerified: lastVerified) : .unverified(lastVerified: lastVerified, reason: reason)
        }
    }
}

/// When an attest may start (pure, with the caller's clock). One at a time; the page's `recheck()` also needs 30 seconds since the
/// last start. Launch, foreground, network change and the timer are paced only by the one-at-a-time rule.
public struct AttestSchedule: Sendable {
    public static let minGap: TimeInterval = 30
    /// While in front, a check every 10 minutes.
    public static let timerInterval: TimeInterval = 600

    private var inFlight = false
    private var lastStart: Date?

    public init() {}

    public var isRunning: Bool { inFlight }

    /// True when one may start now (and marks it running). A clock that stepped back counts as inside the gap.
    public mutating func begin(at now: Date, fromPage: Bool) -> Bool {
        guard !inFlight else { return false }
        if fromPage, let last = lastStart {
            let since = now.timeIntervalSince(last)
            if since < 0 || since < Self.minGap { return false }
        }
        inFlight = true
        lastStart = now
        return true
    }

    public mutating func end() { inFlight = false }
}
