#if DEBUG
import Foundation
import TalosRelayCore

/// DEBUG-only test hook (compiled out of Release): the simulator has no camera. Launch arguments:
///   -TalosDebugEnrollLink <setup link>   opens the sheet at launch and feeds the link to the same handler the scan uses
///                                        (an empty value only opens the sheet)
///   -TalosDebugRelayId <r_...>           answers the descriptor fetch with this relay (plus -TalosDebugKind hosted|self and
///                                        -TalosDebugMinApp <version>) instead of the network
///   -TalosDebugDescriptorFail 1          the descriptor fetch fails as if offline
/// With a stub, the relay list is kept in memory so the simulator's unsigned build needs no Keychain group.
enum DebugAddRelay {
    static let store = RelayStore(backing: InMemoryKeychain())
    static var opened = false
    private static let defaults = UserDefaults.standard

    static var link: String? { defaults.string(forKey: "TalosDebugEnrollLink") }

    struct Stub: DescriptorFetching {
        let json: String?
        let fail: Bool
        func fetch(origin: URL) async throws -> RelayDescriptor {
            if fail { throw DescriptorFetchError.network }
            guard let json, let d = try? JSONDecoder().decode(RelayDescriptor.self, from: Data(json.utf8)) else {
                throw DescriptorFetchError.badAnswer
            }
            return d
        }
    }

    static func stub() -> Stub? {
        let fail = defaults.string(forKey: "TalosDebugDescriptorFail") == "1"
        guard let id = defaults.string(forKey: "TalosDebugRelayId") else { return fail ? Stub(json: nil, fail: true) : nil }
        let kind = defaults.string(forKey: "TalosDebugKind") ?? "self"
        let min = defaults.string(forKey: "TalosDebugMinApp") ?? "0.0.0"
        return Stub(json: #"{"protocol":1,"relay_version":"1.0.0","relay_id":"\#(id)","kind":"\#(kind)","min_app":"\#(min)"}"#, fail: fail)
    }
}
#endif
