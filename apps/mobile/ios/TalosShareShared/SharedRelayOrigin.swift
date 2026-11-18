import Foundation
import TalosRelayCore

/// Where the share extension and the notification quick actions post: the active relay, read from the relay list in the shared
/// Keychain group (the same one the app's scan sheet saves to). The token and the grant they send come from that relay's page, so
/// a different origin would send them to the wrong server. The build-time relay (`CompiledRelay`) is used only by a DEBUG build with
/// nothing paired. The origin is never taken from a web page, a share, or a plugin argument.
enum SharedRelayOrigin {
    #if DEBUG
    static let allowsBuildTimeFallback = true
    #else
    static let allowsBuildTimeFallback = false
    #endif

    static func current(store: RelayStore?, buildTime: URL?, allowBuildTime: Bool) -> URL? {
        ActiveRelay.resolve(store: store, buildTimeURL: buildTime, allowBuildTime: allowBuildTime)?.origin
    }

    /// The real lookup, for the extension and the app.
    static func current(bundle: Bundle = .main) -> URL? { currentActive(bundle: bundle)?.origin }

    /// The same lookup with the profile, for callers that also need the relay's id (the quick actions' keys are per relay).
    static func currentActive(bundle: Bundle = .main) -> ActiveRelay? {
        let store = KeychainTokenStore.group(in: bundle).map { RelayStore(backing: SystemKeychain(accessGroup: $0)) }
        return ActiveRelay.resolve(
            store: store, buildTimeURL: allowsBuildTimeFallback ? CompiledRelay.url(bundle: bundle) : nil,
            allowBuildTime: allowsBuildTimeFallback)
    }
}
