import TalosRelayCore
import XCTest

@testable import App

/// The scan -> profile pipeline with a stubbed descriptor fetch (no network, no Keychain).
final class AddRelayFlowTests: XCTestCase {
    private let fp = String(repeating: "A", count: 43)
    private let code = "01234567890123456789012345"
    private let rid = "r_abcdefghijklmnopqrst"

    /// A non-isolated attester for the flow (the flow is a plain struct): records what it was asked.
    final class StubAttestRunner: AttestRunning, @unchecked Sendable {
        var outcome: AttestOutcome
        private(set) var calls: [(origin: URL, relayID: String, pinnedFP: String, cookie: String?, context: BridgeAttest.Context)] = []
        init(_ o: AttestOutcome) { outcome = o }
        func run(origin: URL, relayID: String, pinnedFP: String, cookie: String?, context: BridgeAttest.Context) async -> AttestOutcome {
            calls.append((origin, relayID, pinnedFP, cookie, context))
            return outcome
        }
    }

    private struct Stub: DescriptorFetching {
        var result: Result<RelayDescriptor, DescriptorFetchError>
        var seen: ((URL) -> Void)?
        func fetch(origin: URL) async throws -> RelayDescriptor { seen?(origin); return try result.get() }
    }

    private func descriptor(kind: String = "self", minApp: String = "0.0.0", id: String? = nil) throws -> RelayDescriptor {
        let json = #"{"protocol":1,"relay_version":"1.0.0","relay_id":"\#(id ?? rid)","kind":"\#(kind)","min_app":"\#(minApp)"}"#
        return try JSONDecoder().decode(RelayDescriptor.self, from: Data(json.utf8))
    }

    private func flow(_ r: Result<RelayDescriptor, DescriptorFetchError>, version: String = "1.0",
                      attest: AttestRunning = StubAttestRunner(.verdict(.pass))) -> AddRelayFlow {
        AddRelayFlow(fetcher: Stub(result: r), attester: attest, appVersion: version, now: { Date(timeIntervalSince1970: 1000) },
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
        XCTAssertEqual(p.profile.lastVerifiedAt, Date(timeIntervalSince1970: 1000), "the profile carries the time of the passing attest")
        XCTAssertEqual(p.verifiedAt, Date(timeIntervalSince1970: 1000))
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
        let f = AddRelayFlow(fetcher: Stub(result: .failure(.network), seen: { _ in fetched = true }), attester: StubAttestRunner(.verdict(.pass)), appVersion: "1.0")
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

    // MARK: BYOR phase 4b: the Mac must pass an attest against the QR's key before anything is saved or the code is sent

    func testPairingChecksTheMacAgainstTheQrKeyWithNoCookieAndTheDescriptorsRelayId() async throws {
        let attest = StubAttestRunner(.verdict(.pass))
        _ = try await flow(.success(descriptor()), attest: attest).prepare(link: "https://Relay.Example.com:8443/enroll#\(code)&fp=\(fp)").get()
        let call = try XCTUnwrap(attest.calls.first)
        XCTAssertEqual(attest.calls.count, 1)
        XCTAssertEqual(call.origin.absoluteString, "https://relay.example.com:8443")
        XCTAssertEqual(call.pinnedFP, fp, "against the fingerprint in the QR, never one the relay told us")
        XCTAssertEqual(call.relayID, rid)
        XCTAssertNil(call.cookie, "no session cookie at pairing")
        XCTAssertEqual(call.context, .pair, "a key change at pairing is a fail, not a re-pin")
    }

    func testPairingRefusesWithoutAPassForEveryOutcome() async throws {
        let outcomes: [AttestOutcome] = [
            .unreachable(.network), .unreachable(.macOffline), .unreachable(.unsupported), .unreachable(.macTimeout),
            .unreachable(.rateLimited), .unreachable(.badAnswer),
            .verdict(.fail(.badShape)), .verdict(.fail(.badKey)), .verdict(.fail(.badSig)), .verdict(.fail(.badChain)),
            .verdict(.fail(.wrongFP)), .verdict(.fail(.repinAtPair)),
            .verdict(.repin(newFP: String(repeating: "B", count: 43))),
        ]
        for o in outcomes {
            let r = await flow(.success(try descriptor()), attest: StubAttestRunner(o)).prepare(link: "https://relay.example.com/enroll#\(code)&fp=\(fp)")
            guard case let .failure(e) = r else { return XCTFail("\(o) must not give a PendingRelay") }
            switch (o, e) {
            case (.unreachable, .macUnreachable), (.verdict, .notYourMac): break
            default: XCTFail("\(o) gave \(e)")
            }
            XCTAssertFalse(e.message.isEmpty)
        }
    }

    func testEachRefusalHasItsOwnWordsAndSaysNothingWasSaved() {
        let host = "relay.example.com"
        let all: [AddRelayError] = [
            .macUnreachable(host: host, why: .macOffline), .macUnreachable(host: host, why: .unsupported),
            .macUnreachable(host: host, why: .macTimeout), .macUnreachable(host: host, why: .rateLimited),
            .macUnreachable(host: host, why: .network), .notYourMac(host: host),
        ]
        XCTAssertEqual(Set(all.map(\.message)).count, 6)
        for e in all { XCTAssertTrue(e.message.contains("Nothing was saved"), e.message) }
        XCTAssertTrue(AddRelayError.macUnreachable(host: host, why: .unsupported).message.contains("update talos-app"))
    }

    func testTheAttestRunsOnlyAfterTheDescriptorAndNeverForABadLink() async {
        let attest = StubAttestRunner(.verdict(.pass))
        _ = await flow(.failure(.network), attest: attest).prepare(link: "https://relay.example.com/enroll#\(code)&fp=\(fp)")
        _ = await flow(.success(try! descriptor()), attest: attest).prepare(link: "https://relay.example.com/enroll#\(code)")
        _ = await flow(.success(try! descriptor()), attest: attest).prepare(link: "http://relay.example.com/enroll#\(code)&fp=\(fp)")
        XCTAssertTrue(attest.calls.isEmpty, "no descriptor, no pin or a bad link: the Mac is never asked")
    }

    func testSaveRefusesAPendingRelayThatHasNoPass() async throws {
        let good = try await flow(.success(descriptor())).prepare(link: "https://relay.example.com/enroll#\(code)&fp=\(fp)").get()
        var unstamped = good.profile
        unstamped.lastVerifiedAt = nil
        let store = RelayStore(backing: InMemoryKeychain())
        XCTAssertThrowsError(try AddRelayFlow.save(PendingRelay(profile: unstamped, note: nil, code: code, verifiedAt: good.verifiedAt), in: store))
        var other = good.profile
        other.lastVerifiedAt = Date(timeIntervalSince1970: 5)
        XCTAssertThrowsError(try AddRelayFlow.save(PendingRelay(profile: other, note: nil, code: code, verifiedAt: good.verifiedAt), in: store))
        XCTAssertEqual(try store.list(), [], "a failed re-pair must never reach add(), which replaces the whole list")
    }

    func testTheRealTransportRefusesPlainHttp() async {
        let r = await URLSessionAttestTransport().post(url: URL(string: "http://relay.example.com/api/bridge/attest")!, body: Data(), cookie: nil, timeout: 1)
        XCTAssertEqual(r, .failed)
    }
}
