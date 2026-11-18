import XCTest
@testable import TalosRelayCore

private struct Vector: Decodable {
    let name: String
    let link: String
    let ok: Bool
    let code: String?
    let fp: String?
    let error: String?
    let origin: String?
}

private struct VectorFile: Decodable { let links: [Vector] }

/// Runs every enroll-link vector through the parser (the parser only: the app's no-fp refusal is tested separately).
/// The vectors are packages/protocol/fixtures/enroll-link/vectors.json, shared with the TS parser, when that file is on
/// disk (found from this file's path); until the shared file lands, the local copy in Fixtures/ (same shape) is used.
/// When phase 2 lands, move the local copy there and delete it, as the release-manifest vectors are shared.
final class EnrollLinkTests: XCTestCase {
    private func load() throws -> [Vector] {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<7 { dir.deleteLastPathComponent() }  // the repo root: Tests/<target>/<file> inside apps/mobile/ios/<pkg>
        let shared = dir.appending(path: "packages/protocol/fixtures/enroll-link/vectors.json")
        let url = FileManager.default.fileExists(atPath: shared.path)
            ? shared
            : try XCTUnwrap(Bundle.module.url(forResource: "enroll-link-vectors", withExtension: "json", subdirectory: "Fixtures"))
        // Say which file ran, so a rename of the shared file cannot silently fall back to the local copy.
        print("EnrollLinkTests: vectors from \(url.path) (shared file \(url == shared ? "found" : "MISSING, local copy used"))")
        return try JSONDecoder().decode(VectorFile.self, from: Data(contentsOf: url)).links
    }

    func testEveryVector() throws {
        let cases = try load()
        XCTAssertGreaterThanOrEqual(cases.count, 35)
        for v in cases {
            switch EnrollLink.parse(v.link) {
            case let .success(l):
                XCTAssertTrue(v.ok, "\(v.name): parsed but should fail with \(v.error ?? "?")")
                XCTAssertEqual(l.code, v.code, v.name)
                XCTAssertEqual(l.fp, v.fp, v.name)
                if let want = v.origin { XCTAssertEqual(l.origin.absoluteString, want, v.name) }
                XCTAssertEqual(l.origin.path, "", v.name)
            case let .failure(e):
                XCTAssertFalse(v.ok, "\(v.name): failed with \(e.rawValue) but should parse")
                XCTAssertEqual(e.rawValue, v.error, v.name)
            }
        }
    }

    func testOriginKeepsPortOnly() throws {
        let l = try EnrollLink.parse("https://relay.example.com:8443/enroll#0123456789abcdefghjkmnpqrs").get()
        XCTAssertEqual(l.origin.absoluteString, "https://relay.example.com:8443")
    }

    func testAppRefusesLinkWithoutPin() throws {
        let bare = try EnrollLink.parse("https://relay.example.com/enroll#0123456789abcdefghjkmnpqrs").get()
        XCTAssertEqual(bare.requirePin(), .failure(.noFp))
        let fp = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO-_"
        let pinned = try EnrollLink.parse("https://relay.example.com/enroll#0123456789abcdefghjkmnpqrs&fp=\(fp)").get()
        XCTAssertEqual(pinned.requirePin(), .success(fp))
    }
}
