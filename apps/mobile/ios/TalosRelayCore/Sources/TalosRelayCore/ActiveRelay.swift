import Foundation

/// The one relay the shell is on: where the web view loads, what the bridge guard and the plugin gate compare against, and
/// which data store holds its cookies. Every one of those reads this value, so they cannot disagree (BYOR.md 3.1, 10d).
///
/// The origin comes only from a stored `RelayProfile`, and a profile is only ever saved by the native scan. The build-time URL
/// is a fallback for development builds when nothing is paired; a release build never uses it.
public struct ActiveRelay: Equatable {
    public let origin: URL
    /// nil for the build-time fallback, which keeps the default data store.
    public let profile: RelayProfile?

    public var dataStoreId: UUID? { profile?.dataStoreId }

    public static func resolve(store: RelayStore?, buildTimeURL: URL?, allowBuildTime: Bool) -> ActiveRelay? {
        if let store {
            // A damaged list is not "no profile": it never falls back to a build-time origin.
            do {
                if let p = try store.active() { return ActiveRelay(origin: p.origin, profile: p) }
            } catch {
                return nil
            }
        }
        guard allowBuildTime, let buildTimeURL else { return nil }
        return ActiveRelay(origin: buildTimeURL, profile: nil)
    }

    /// The entry Capacitor's navigation allow-list takes: the host, with a non-default port (the shape `new URL(origin).host`
    /// gives in capacitor.config.ts).
    public static func navigationHost(of origin: URL) -> String {
        let host = origin.host ?? origin.absoluteString
        return origin.port.map { "\(host):\($0)" } ?? host
    }
}

/// One WebKit data store per relay, named by the profile's `dataStoreId`. This is the pure part: which stores are left behind.
public enum RelayDataStores {
    /// Stores that exist but belong to no stored profile (a removed or replaced relay).
    public static func orphans(existing: [UUID], owned: [UUID]) -> [UUID] {
        let keep = Set(owned)
        return existing.filter { !keep.contains($0) }
    }
}
