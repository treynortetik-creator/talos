import Foundation

/// How far the app trusts that the relay it is on answers for the owner's Mac. Only `.pass` exists for now. Later states (the
/// Mac could not be confirmed, or failed the check) are added here; the `switch` below then fails to compile until each one says
/// what it allows, and so does every guard method that takes the state.
public enum RelayTrustState: Sendable, Equatable {
    case pass

    /// Plugin calls, camera, microphone, sharing and prompt() messages.
    public var allowsNativeFeatures: Bool {
        switch self {
        case .pass: return true
        }
    }
}

/// The one shared reference to the current trust state. The view controller makes it once per relay and injects the SAME object into
/// every site that guards native access (the bridge handler, the share handler, the navigation gate, the plugin gate). Each site
/// reads `state` when a call arrives and hands it to the `BridgeGuard` method, which stays a pure value.
public final class RelayTrust: @unchecked Sendable {
    /// False until RelayTrust can reach a verified or unverified state. The attest commit (BYOR-phase4-frame.md) sets it to true;
    /// scripts/testflight.sh refuses to ship while it is false, because the app would trust any scanned relay without verifying the Mac.
    public static let verifiesTheMac = false

    private let lock = NSLock()
    private var current: RelayTrustState

    public init(_ state: RelayTrustState = .pass) { current = state }

    public var state: RelayTrustState {
        lock.lock()
        defer { lock.unlock() }
        return current
    }
}
