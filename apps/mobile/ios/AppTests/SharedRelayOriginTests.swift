import TalosRelayCore
import XCTest

@testable import App

/// The share extension and the notification quick actions post to the active relay, the one the page's token and grant came
/// from, never to the build-time one when a relay is paired.
final class SharedRelayOriginTests: XCTestCase {
    private func store(host: String?) throws -> RelayStore {
        let s = RelayStore(backing: InMemoryKeychain())
        if let host {
            try s.add(RelayProfile(
                id: "r_abcdefghijklmnopqrst", origin: URL(string: "https://\(host)")!, kind: .self, label: host,
                bridgeFp: String(repeating: "A", count: 43), deviceId: "", dataStoreId: UUID(), addedAt: Date())!)
        }
        return s
    }

    private let buildTime = URL(string: "https://build.example.com")!

    func testAPairedRelayWinsOverTheBuildTimeRelay() throws {
        for allow in [true, false] {
            let url = SharedRelayOrigin.current(store: try store(host: "mine.example.com"), buildTime: buildTime, allowBuildTime: allow)
            XCTAssertEqual(url?.absoluteString, "https://mine.example.com")
        }
    }

    func testTheBuildTimeRelayIsOnlyTheDebugFallbackWithNothingPaired() throws {
        XCTAssertEqual(SharedRelayOrigin.current(store: try store(host: nil), buildTime: buildTime, allowBuildTime: true), buildTime)
        XCTAssertNil(SharedRelayOrigin.current(store: try store(host: nil), buildTime: buildTime, allowBuildTime: false))
        XCTAssertNil(SharedRelayOrigin.current(store: nil, buildTime: buildTime, allowBuildTime: false))
    }

    func testTheShippingDefaultOnlyFallsBackInDebugBuilds() {
        #if DEBUG
        XCTAssertTrue(SharedRelayOrigin.allowsBuildTimeFallback)
        #else
        XCTAssertFalse(SharedRelayOrigin.allowsBuildTimeFallback)
        #endif
    }
}
