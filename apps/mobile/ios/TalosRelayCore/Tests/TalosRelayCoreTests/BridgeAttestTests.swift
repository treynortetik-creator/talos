import CryptoKit
import XCTest
@testable import TalosRelayCore

private struct KeyV: Decodable { let seed_hex: String; let pubkey: String; let fp: String }
private struct Expect: Decodable { let verdict: String; let new_fp: String?; let reason: String? }
private struct CaseV: Decodable { let name: String; let context: String; let pinned_fp: String; let body_hex: String; let expect: Expect }
private struct VectorFile: Decodable {
    let nonce: String; let origin: String; let relay_id: String
    let keys: [String: KeyV]
    let attest_bytes_hex: String; let attest_sig: String; let cert_bytes_hex: String; let cert_sig: String
    let cases: [CaseV]
}

/// Runs the shared vectors, packages/protocol/fixtures/bridge-attest/vectors.json (found from this file's path, as the
/// enroll-link vectors are). The file mirrors the TypeScript reference's vectors; the TS tests run the same cases.
final class BridgeAttestTests: XCTestCase {
    private func load() throws -> VectorFile {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<7 { dir.deleteLastPathComponent() }
        let url = dir.appending(path: "packages/protocol/fixtures/bridge-attest/vectors.json")
        return try JSONDecoder().decode(VectorFile.self, from: Data(contentsOf: url))
    }

    private func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }
    private func unhex(_ s: String) -> Data {
        var out = Data()
        var i = s.startIndex
        while i < s.endIndex {
            let j = s.index(i, offsetBy: 2)
            out.append(UInt8(s[i..<j], radix: 16)!)
            i = j
        }
        return out
    }
    private func b64u(_ s: String) -> Data {
        var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while t.count % 4 != 0 { t += "=" }
        return Data(base64Encoded: t)!
    }

    func testEveryVectorCase() throws {
        let v = try load()
        XCTAssertGreaterThanOrEqual(v.cases.count, 62)
        for c in v.cases {
            let ctx: BridgeAttest.Context = c.context == "pair" ? .pair : .reconnect
            let got = BridgeAttest.check(body: unhex(c.body_hex), nonce: v.nonce, origin: v.origin, relayID: v.relay_id, pinnedFP: c.pinned_fp, context: ctx)
            let want: BridgeAttest.Verdict
            switch c.expect.verdict {
            case "pass": want = .pass
            case "repin": want = .repin(newFP: c.expect.new_fp ?? "?")
            default: want = .fail(BridgeAttest.Reason(rawValue: c.expect.reason ?? "?") ?? .badShape)
            }
            XCTAssertEqual(got, want, "case: \(c.name)")
        }
    }

    func testBytesMatchVectorsByteForByte() throws {
        let v = try load()
        let k2 = try XCTUnwrap(v.keys["k2"]), k0 = try XCTUnwrap(v.keys["k0"]), k1 = try XCTUnwrap(v.keys["k1"])
        XCTAssertEqual(try hex(BridgeAttest.attestBytes(nonce: v.nonce, origin: v.origin, fp: k2.fp)), v.attest_bytes_hex)
        XCTAssertEqual(try hex(BridgeAttest.certBytes(relayID: v.relay_id, oldFP: k0.fp, newFP: k1.fp)), v.cert_bytes_hex)
    }

    func testFingerprintsOfSeedKeys() throws {
        let v = try load()
        for (name, k) in v.keys {
            let priv = try Curve25519.Signing.PrivateKey(rawRepresentation: unhex(k.seed_hex))
            XCTAssertEqual(priv.publicKey.rawRepresentation, b64u(k.pubkey), name)
            XCTAssertEqual(BridgeAttest.fp(ofRawKey: priv.publicKey.rawRepresentation), k.fp, name)
            XCTAssertTrue(BridgeAttest.isCanonicalFP(k.fp), name)
        }
    }

    func testSignaturesVerifyAgainstSeedKeys() throws {
        let v = try load()
        let k2 = try Curve25519.Signing.PrivateKey(rawRepresentation: unhex(try XCTUnwrap(v.keys["k2"]).seed_hex))
        let k0 = try Curve25519.Signing.PrivateKey(rawRepresentation: unhex(try XCTUnwrap(v.keys["k0"]).seed_hex))
        XCTAssertTrue(k2.publicKey.isValidSignature(b64u(v.attest_sig), for: unhex(v.attest_bytes_hex)))
        XCTAssertTrue(k0.publicKey.isValidSignature(b64u(v.cert_sig), for: unhex(v.cert_bytes_hex)))
        XCTAssertFalse(k0.publicKey.isValidSignature(b64u(v.attest_sig), for: unhex(v.attest_bytes_hex)))
    }

    func testCanonicalFP() {
        XCTAssertTrue(BridgeAttest.isCanonicalFP("ti6Gf6LzOv5i1daxZC4WIdVDMHhGsqV7iX5xCRm3Zwk"))
        XCTAssertFalse(BridgeAttest.isCanonicalFP("ti6Gf6LzOv5i1daxZC4WIdVDMHhGsqV7iX5xCRm3Zwl"))  // spare bits set
        XCTAssertFalse(BridgeAttest.isCanonicalFP("short"))
        XCTAssertFalse(BridgeAttest.isCanonicalFP("ti6Gf6LzOv5i1daxZC4WIdVDMHhGsqV7iX5xCRm3Zw="))
    }

    // MARK: strict reading, size, small-order keys, relay id

    /// The answer of the first vector case (k2 signs, pinned k2) and of the three-key chain case (pinned k0, repin).
    private func bodies() throws -> (v: VectorFile, plain: String, chain: String) {
        let v = try load()
        let plain = try XCTUnwrap(v.cases.first { $0.name == "the pinned key signs: pass" })
        let chain = try XCTUnwrap(v.cases.first { $0.name == "a chain from the pinned key to the signing key: repin" })
        return (v, String(decoding: unhex(plain.body_hex), as: UTF8.self), String(decoding: unhex(chain.body_hex), as: UTF8.self))
    }

    private func run(_ v: VectorFile, _ body: Data, pinned: String? = nil, relayID: String? = nil) -> BridgeAttest.Verdict {
        BridgeAttest.check(
            body: body, nonce: v.nonce, origin: v.origin, relayID: relayID ?? v.relay_id,
            pinnedFP: pinned ?? v.keys["k2"]!.fp, context: .reconnect)
    }

    func testReaderRefusesWhatJavaScriptAndAppleReadDifferently() throws {
        let (v, plain, chain) = try bodies()
        let sig = v.attest_sig
        let k2 = v.keys["k2"]!.pubkey
        XCTAssertEqual(run(v, Data(plain.utf8)), .pass)  // the baseline every case below changes
        let bad: [String: Data] = [
            "leading BOM": Data([0xEF, 0xBB, 0xBF] + Array(plain.utf8)),
            "trailing comma in the object": Data(plain.replacingOccurrences(of: "\"chain\":[]}", with: "\"chain\":[],}").utf8),
            "trailing comma in the array": Data(chain.replacingOccurrences(of: "}]}", with: "},]}").utf8),
            "duplicate top-level key": Data("{\"pubkey\":\"\(k2)\",\"sig\":\"\(sig)\",\"chain\":[],\"sig\":\"\(sig)\"}".utf8),
            "duplicate key spelled with an escape": Data("{\"pubkey\":\"\(k2)\",\"p\\u0075bkey\":\"\(k2)\",\"sig\":\"\(sig)\",\"chain\":[]}".utf8),
            "duplicate key inside a chain entry": Data(
                chain.replacingOccurrences(of: "{\"relay_id\"", with: "{\"relay_id\":\"r_abcdefghijklmnopqrst\",\"relay_id\"").utf8),
            "lone high surrogate": Data("{\"pubkey\":\"\(k2)\",\"sig\":\"\\ud800\",\"chain\":[]}".utf8),
            "lone low surrogate": Data("{\"pubkey\":\"\(k2)\",\"sig\":\"\\udc00\",\"chain\":[]}".utf8),
            "bytes that are not UTF-8": Data("{\"pubkey\":\"".utf8) + Data([0xFF]) + Data("\",\"sig\":\"\(sig)\",\"chain\":[]}".utf8),
            "text after the object": Data((plain + " x").utf8),
            "a comment": Data((plain + "//").utf8),
            "an unquoted key": Data("{pubkey:\"\(k2)\",\"sig\":\"\(sig)\",\"chain\":[]}".utf8),
            "nesting past the bound": Data(String(repeating: "[", count: 40).utf8),
        ]
        for (name, body) in bad { XCTAssertEqual(run(v, body), .fail(.badShape), name) }
    }

    func testReaderRefusesKeysThatAreCanonicallyEquivalent() {
        // Swift String equality merges these; they must be refused, never silently merged into one key
        let composedThenDecomposed = "{\"\u{e9}\":1,\"e\u{301}\":2}"
        let kelvin = "{\"K\":1,\"\u{212A}\":2}"
        for text in [composedThenDecomposed, kelvin] { XCTAssertNil(StrictJSON.parse(Data(text.utf8)), text) }
        XCTAssertNotNil(StrictJSON.parse(Data("{\"a\":1,\"b\":2}".utf8)))
    }

    func testReaderNestingBoundIsExactlySixteenLevels() throws {
        func nested(_ n: Int) -> Data { Data((String(repeating: "[", count: n) + String(repeating: "]", count: n)).utf8) }
        XCTAssertNotNil(StrictJSON.parse(nested(16)))
        XCTAssertNil(StrictJSON.parse(nested(17)))
        XCTAssertNotNil(StrictJSON.parse(Data((String(repeating: "[", count: 16) + "\"x\"" + String(repeating: "]", count: 16)).utf8)))
        // and through the check: 17 balanced levels are bad_shape
        let v = try load()
        let got = BridgeAttest.check(
            body: nested(17), nonce: v.nonce, origin: v.origin, relayID: v.relay_id,
            pinnedFP: v.keys["k2"]!.fp, context: .reconnect)
        XCTAssertEqual(got, .fail(.badShape))
    }

    func testReaderDecodesEscapesAndSpaceLikeJSON() throws {
        let (v, plain, _) = try bodies()
        XCTAssertEqual(run(v, Data(plain.replacingOccurrences(of: "\"pubkey\"", with: "\"pub\\u006bey\"").utf8)), .pass)
        XCTAssertEqual(run(v, Data(" \n\t\(plain)\r\n".utf8)), .pass)
    }

    func testBodyCapIsOnRawBytesBeforeDecoding() throws {
        let (v, plain, _) = try bodies()
        let room = BridgeAttest.bodyMax - plain.utf8.count
        XCTAssertEqual(run(v, Data((plain + String(repeating: " ", count: room)).utf8)), .pass)  // exactly the cap
        XCTAssertEqual(run(v, Data((plain + String(repeating: " ", count: room + 1)).utf8)), .fail(.badShape))
        // 4096 two-byte characters inside a string are 4096 characters but over the cap in bytes
        let wide = "{\"pubkey\":\"\(String(repeating: "é", count: 4200))\",\"sig\":\"x\",\"chain\":[]}"
        XCTAssertEqual(run(v, Data(wide.utf8)), .fail(.badShape))
    }

    func testSmallOrderKeysAreBadKey() throws {
        let (v, plain, chain) = try bodies()
        let encodings = [
            "0100000000000000000000000000000000000000000000000000000000000000",
            "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
            "0000000000000000000000000000000000000000000000000000000000000000",
            "0000000000000000000000000000000000000000000000000000000000000080",
            "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
            "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
            "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
            "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
        ]
        let k2 = v.keys["k2"]!.pubkey, k1 = v.keys["k1"]!.pubkey
        for hexKey in encodings {
            let text = b64uEncode(unhex(hexKey))
            // the signing key itself; pinned to its own fp so only the key rule can refuse it
            let own = Data(plain.replacingOccurrences(of: k2, with: text).utf8)
            XCTAssertEqual(run(v, own, pinned: BridgeAttest.fp(ofRawKey: unhex(hexKey))), .fail(.badKey), hexKey)
            // a small-order key in the middle of a chain
            let mid = Data(chain.replacingOccurrences(of: "\"new_pubkey\":\"\(k1)\"", with: "\"new_pubkey\":\"\(text)\"").utf8)
            XCTAssertEqual(run(v, mid, pinned: v.keys["k0"]!.fp), .fail(.badChain), hexKey)
        }
    }

    func testKeysWithYNotBelowPAreBadKeyWhateverTheSignBit() throws {
        let (v, plain, _) = try bodies()
        let k2 = v.keys["k2"]!.pubkey
        // y = p, p + 1 (non-canonical), and each small-order y with the sign bit set
        var cases = ["edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
                     "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
                     "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"]
        cases.append("0100000000000000000000000000000000000000000000000000000000000080")
        cases.append("ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")
        for h in cases {
            let body = Data(plain.replacingOccurrences(of: k2, with: b64uEncode(unhex(h))).utf8)
            XCTAssertEqual(run(v, body, pinned: BridgeAttest.fp(ofRawKey: unhex(h))), .fail(.badKey), h)
        }
    }

    private func le(_ y: String) -> String {  // a small y as 32 little-endian bytes in hex
        let n = UInt64(y)!
        return (0..<32).map { String(format: "%02x", $0 < 8 ? UInt8((n >> (8 * UInt64($0))) & 255) : 0) }.joined()
    }

    func testKeysThatAreNotCurvePointsAreBadKey() throws {
        let (v, plain, chain) = try bodies()
        let k2 = v.keys["k2"]!.pubkey, k1 = v.keys["k1"]!.pubkey
        // y values whose x^2 = (y^2 - 1) / (d y^2 + 1) is not a square mod p (found with a separate big-integer check)
        let offCurve = [le("2"), le("7"), le("8"), le("11"), le("12"), le("13"),
                        "ebffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",  // y = p - 2
                        "0000000000000000000000000000000000000000000000000000000000000040"]  // y = 2^254
        for h in offCurve {
            let text = b64uEncode(unhex(h))
            let own = Data(plain.replacingOccurrences(of: k2, with: text).utf8)
            XCTAssertEqual(run(v, own, pinned: BridgeAttest.fp(ofRawKey: unhex(h))), .fail(.badKey), h)
            let mid = Data(chain.replacingOccurrences(of: "\"new_pubkey\":\"\(k1)\"", with: "\"new_pubkey\":\"\(text)\"").utf8)
            XCTAssertEqual(run(v, mid, pinned: v.keys["k0"]!.fp), .fail(.badChain), h)
        }
        // on-curve y values are not refused as keys: they fail later, on the signature
        for y in ["3", "4", "5", "6", "9", "10"] {
            let h = le(y)
            let body = Data(plain.replacingOccurrences(of: k2, with: b64uEncode(unhex(h))).utf8)
            XCTAssertEqual(run(v, body, pinned: BridgeAttest.fp(ofRawKey: unhex(h))), .fail(.badSig), "y=\(y)")
        }
    }

    func testOnCurveTestAgreesWithSeparateBigIntegerResults() throws {
        for y in ["3", "4", "5", "6", "9", "10"] { XCTAssertTrue(Ed25519Point.isOnCurve(unhex(le(y))), "y=\(y)") }
        for y in ["2", "7", "8", "11", "12", "13"] { XCTAssertFalse(Ed25519Point.isOnCurve(unhex(le(y))), "y=\(y)") }
        // x = 0 (y = 1, and y = p - 1) is a point only with the sign bit clear
        XCTAssertTrue(Ed25519Point.isOnCurve(unhex(le("1"))))
        XCTAssertFalse(Ed25519Point.isOnCurve(unhex("0100000000000000000000000000000000000000000000000000000000000080")))
        XCTAssertTrue(Ed25519Point.isOnCurve(unhex("ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f")))
        XCTAssertFalse(Ed25519Point.isOnCurve(unhex("ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")))
        // y >= p is not a point; every real key of the vectors is
        XCTAssertFalse(Ed25519Point.isOnCurve(unhex("edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f")))
        for k in try load().keys.values { XCTAssertTrue(Ed25519Point.isOnCurve(b64u(k.pubkey)), k.pubkey) }
        XCTAssertFalse(Ed25519Point.isOnCurve(Data(count: 31)))
    }

    func testByteHelpersThrowOnMalformedFields() throws {
        let v = try load()
        let fp = v.keys["k2"]!.fp
        XCTAssertThrowsError(try BridgeAttest.attestBytes(nonce: "short", origin: v.origin, fp: fp))
        XCTAssertThrowsError(try BridgeAttest.attestBytes(nonce: v.nonce, origin: v.origin, fp: fp + "A"))
        XCTAssertThrowsError(try BridgeAttest.attestBytes(nonce: v.nonce, origin: "https://a b", fp: fp))
        XCTAssertThrowsError(try BridgeAttest.attestBytes(nonce: v.nonce, origin: "https://a\nb", fp: fp))
        XCTAssertThrowsError(try BridgeAttest.attestBytes(nonce: v.nonce, origin: "", fp: fp))
        XCTAssertThrowsError(try BridgeAttest.attestBytes(nonce: v.nonce, origin: "https://é.example", fp: fp))
        XCTAssertThrowsError(try BridgeAttest.certBytes(relayID: "r_short", oldFP: fp, newFP: fp))
        XCTAssertThrowsError(try BridgeAttest.certBytes(relayID: v.relay_id, oldFP: "x", newFP: fp))
        XCTAssertThrowsError(try BridgeAttest.certBytes(relayID: v.relay_id, oldFP: fp, newFP: fp + "\n"))
    }

    func testRelayIDMustBeWellFormed() throws {
        let (v, plain, _) = try bodies()
        for id in ["", "r_abc", "R_abcdefghijklmnopqrst", "r_abcdefghijklmnopqrs1", "r_abcdefghijklmnopqrstu"] {
            XCTAssertEqual(run(v, Data(plain.utf8), relayID: id), .fail(.badShape), id)
        }
    }

    private func b64uEncode(_ d: Data) -> String {
        d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
