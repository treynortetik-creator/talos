import TalosRelayCore
import XCTest

@testable import App

/// The scan -> profile pipeline with a stubbed descriptor fetch (no network, no Keychain).
final class AddRelayFlowTests: XCTestCase {
    private let fp = String(repeating: "A", count: 43)
    private let code = "01234567890123456789012345"
    private let rid = "r_abcdefghijklmnopqrst"

    private struct Stub: DescriptorFetching {
        var result: Result<RelayDescriptor, DescriptorFetchError>
        var seen: ((URL) -> Void)?
        func fetch(origin: URL) async throws -> RelayDescriptor { seen?(origin); return try result.get() }
    }

    private func descriptor(kind: String = "self", minApp: String = "0.0.0", id: String? = nil) throws -> RelayDescriptor {
        let json = #"{"protocol":1,"relay_version":"1.0.0","relay_id":"\#(id ?? rid)","kind":"\#(kind)","min_app":"\#(minApp)"}"#
        return try JSONDecoder().decode(RelayDescriptor.self, from: Data(json.utf8))
    }

    private func flow(_ r: Result<RelayDescriptor, DescriptorFetchError>, version: String = "1.0") -> AddRelayFlow {
        AddRelayFlow(fetcher: Stub(result: r), appVersion: version, now: { Date(timeIntervalSince1970: 1000) },
                     newDataStoreId: { UUID(uuidString: "00000000-0000-0000-0000-000000000001")! })
    }

    func testGoodLinkBuildsTheProfile() async throws {
        let p = try await flow(.success(descriptor(kind: "hosted"))).prepare(link: "https://Relay.Example.com/enroll#\(code)&fp=\(fp)").get()
        XCTAssertEqual(p.profile.id, rid)
        XCTAssertEqual(p.profile.origin.absoluteString, "https://relay.example.com")
        XCTAssertEqual(p.profile.kind, .hosted)
        XCTAssertEqual(p.profile.label, "relay.example.com")
        XCTAssertEqual(p.host, "relay.example.com")
        XCTAssertEqual(p.profile.bridgeFp, fp)
        XCTAssertEqual(p.profile.dataStoreId.uuidString, "00000000-0000-0000-0000-000000000001")
        XCTAssertEqual(p.profile.addedAt, Date(timeIntervalSince1970: 1000))
        XCTAssertNil(p.note)
        XCTAssertEqual(p.code, code, "the scanned code is kept in memory for the page's enroll step")
    }

    func testPortStaysInTheShownHost() async throws {
        let p = try await flow(.success(descriptor())).prepare(link: "https://relay.example.com:8443/enroll#\(code)&fp=\(fp)").get()
        XCTAssertEqual(p.host, "relay.example.com:8443")
    }

    func testEachParserErrorHasItsOwnWords() async {
        let cases: [(String, AddRelayError)] = [
            ("http://relay.example.com/enroll#\(code)&fp=\(fp)", .link(.badLink)),
            ("https://relay.example.com/enroll#short&fp=\(fp)", .link(.noCode)),
            ("https://relay.example.com/enroll#\(code)&fp=abc", .link(.badFp)),
            ("https://relay.example.com/enroll#\(code)&fp=\(fp)&fp=\(fp)", .link(.dupFp)),
            ("https://relay.example.com/enroll#\(code)", .noFp),
        ]
        var seen = Set<String>()
        for (link, want) in cases {
            let r = await flow(.success(try! descriptor())).prepare(link: link)
            guard case let .failure(e) = r else { return XCTFail("\(link) should fail") }
            XCTAssertEqual(e, want, link)
            seen.insert(e.message)
        }
        XCTAssertEqual(seen.count, cases.count, "one message per error")
        XCTAssertEqual(AddRelayError.noFp.message, "This setup link is from an older Talos. Update Talos on your Mac and show the code again.")
    }

    func testNoPinNeverFetches() async {
        var fetched = false
        let f = AddRelayFlow(fetcher: Stub(result: .failure(.network), seen: { _ in fetched = true }), appVersion: "1.0")
        _ = await f.prepare(link: "https://relay.example.com/enroll#\(code)")
        XCTAssertFalse(fetched)
    }

    func testFetchFailuresAreTold() async {
        let net = await flow(.failure(.network)).prepare(link: "https://relay.example.com/enroll#\(code)&fp=\(fp)")
        XCTAssertEqual(net, .failure(.unreachable(host: "relay.example.com")))
        let bad = await flow(.failure(.badAnswer)).prepare(link: "https://relay.example.com/enroll#\(code)&fp=\(fp)")
        XCTAssertEqual(bad, .failure(.notARelay(host: "relay.example.com")))
    }

    func testMinAppIsAnAdviceNeverABlock() async throws {
        let p = try await flow(.success(descriptor(minApp: "9.0.0")), version: "1.0").prepare(link: "https://relay.example.com/enroll#\(code)&fp=\(fp)").get()
        XCTAssertEqual(p.note, "This relay asks for Talos 9.0.0 or newer. Please update the app.")
    }

    func testSaveWritesTheOnlyRelayAndMakesItActive() async throws {
        let p = try await flow(.success(descriptor())).prepare(link: "https://relay.example.com/enroll#\(code)&fp=\(fp)").get()
        let store = RelayStore(backing: InMemoryKeychain())
        try AddRelayFlow.save(p, in: store)
        XCTAssertEqual(try store.list(), [p.profile])
        XCTAssertEqual(try store.activeId(), rid)
    }

    func testTheRealFetcherRefusesPlainHttp() async {
        do {
            _ = try await URLSessionDescriptorFetcher().fetch(origin: URL(string: "http://relay.example.com")!)
            XCTFail("http must be refused")
        } catch { XCTAssertEqual(error as? DescriptorFetchError, .badAnswer) }
    }

    func testReadCappedStopsAtTheCapWithoutReadingTheRest() async {
        var pulled = 0
        let stream = AsyncStream<UInt8> { c in
            for _ in 0..<1_000_000 { c.yield(1) }
            c.finish()
        }
        let counted = stream.map { b -> UInt8 in pulled += 1; return b }
        do {
            _ = try await URLSessionDescriptorFetcher.readCapped(counted, cap: 100)
            XCTFail("over the cap must fail")
        } catch { XCTAssertEqual(error as? DescriptorFetchError, .badAnswer) }
        XCTAssertEqual(pulled, 101)
        let ok = try? await URLSessionDescriptorFetcher.readCapped(AsyncStream<UInt8> { c in c.yield(7); c.finish() }, cap: 100)
        XCTAssertEqual(ok, Data([7]))
    }
}
