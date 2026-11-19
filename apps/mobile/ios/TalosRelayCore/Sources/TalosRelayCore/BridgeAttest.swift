import CryptoKit
import Foundation

/// The phone's check of a bridge attest answer (docs/specs/BYOR-phase4-frame.md sections 3, 4 and 6). Pure: no network, no
/// state, no side effects. The check order is the one in the design note: (1) the body's size and shape; (2) the key is 32
/// bytes and fp(K) is its canonical text; (3) fp(K) is the pinned fp, or a rotation chain leads from the pinned fp to it;
/// (4) K's signature over the attest bytes. At pairing only a plain pass counts: a valid chain there fails.
/// The shared vectors (packages/protocol/fixtures/bridge-attest/vectors.json) run the same cases as the TypeScript check.
public enum BridgeAttest: Sendable {
    public enum Context: String, Sendable { case pair, reconnect }
    public enum Reason: String, Sendable, Equatable {
        case badShape = "bad_shape", badKey = "bad_key", badSig = "bad_sig", badChain = "bad_chain"
        case wrongFP = "wrong_fp", repinAtPair = "repin_at_pair"
    }
    public enum Verdict: Sendable, Equatable {
        case pass
        case repin(newFP: String)
        case fail(Reason)
    }

    public static let attestDomain = "talos-bridge-attest/v1"
    public static let certDomain = "talos-rotate-cert/v1"
    public static let bodyMax = 8192
    public static let chainMax = 8

    public struct BadField: Error, Equatable {}

    /// 43 characters of the base64url alphabet (not necessarily canonical).
    private static func isB64_43(_ s: String) -> Bool {
        let u = Array(s.utf8)
        return u.count == 43 && u.allSatisfy { alphabet.contains($0) }
    }

    /// Origin text is 0x21-0x7E only: a space or newline inside a field would let two inputs give the same bytes.
    private static func isPrintableOrigin(_ s: String) -> Bool {
        !s.isEmpty && s.utf8.allSatisfy { (0x21...0x7E).contains($0) }
    }

    /// The signed bytes of an attest: UTF-8, LF only, no trailing LF; nonce and fp are their base64url text.
    /// Throws on a malformed field (a 43-character nonce and fp, an origin of 0x21-0x7E only).
    public static func attestBytes(nonce: String, origin: String, fp: String) throws -> Data {
        guard isB64_43(nonce), isB64_43(fp), isPrintableOrigin(origin) else { throw BadField() }
        return Data("\(attestDomain)\n\(nonce)\n\(origin)\n\(fp)".utf8)
    }

    /// The signed bytes of a rotation certificate (signed by the OLD key): all text. Throws on a malformed field.
    public static func certBytes(relayID: String, oldFP: String, newFP: String) throws -> Data {
        guard RelayID.isValid(relayID), isB64_43(oldFP), isB64_43(newFP) else { throw BadField() }
        return Data("\(certDomain)\n\(relayID)\n\(oldFP)\n\(newFP)".utf8)
    }

    /// 43 base64url characters whose last one has its 2 spare bits clear: the one text of a 32-byte value.
    public static func isCanonicalFP(_ s: String) -> Bool { decode32(s) != nil }

    /// base64url, no padding, of SHA-256 of the raw key.
    public static func fp(ofRawKey raw: Data) -> String { encode(Data(SHA256.hash(data: raw))) }

    public static func check(
        body: Data, nonce: String, origin: String, relayID: String, pinnedFP: String, context: Context
    ) -> Verdict {
        // Inputs the phone itself supplies: a malformed one is a bug or a bad link, never a pass.
        guard RelayID.isValid(relayID), isB64_43(nonce), isPrintableOrigin(origin) else { return .fail(.badShape) }
        guard let ans = parse(body) else { return .fail(.badShape) }
        guard let k = usableKey(ans.pubkey) else { return .fail(.badKey) }
        let fpK = fp(ofRawKey: k)
        guard isCanonicalFP(pinnedFP) else { return .fail(.wrongFP) }
        // The cap holds whoever signs; the entries are read only when the chain is walked.
        if ans.chain.count > chainMax { return .fail(.badChain) }

        var viaChain = false
        if fpK != pinnedFP {
            if ans.chain.isEmpty { return .fail(.wrongFP) }
            // Skip, unread, to the FIRST entry that starts at the pinned key (a phone pinned to a middle key); each later one must follow on.
            guard let start = ans.chain.firstIndex(where: { e in
                usableKey(e.oldPubkey).map { fp(ofRawKey: $0) == pinnedFP } ?? false
            }) else { return .fail(.badChain) }
            var current = pinnedFP
            var seen: Set<String> = [current]
            for e in ans.chain[start...] {
                guard let oldRaw = usableKey(e.oldPubkey), let newRaw = usableKey(e.newPubkey), RelayID.isValid(e.relayID)
                else { return .fail(.badChain) }
                if e.relayID != relayID || fp(ofRawKey: oldRaw) != current { return .fail(.badChain) }
                let next = fp(ofRawKey: newRaw)
                if seen.contains(next) { return .fail(.badChain) }
                guard let cert = try? certBytes(relayID: e.relayID, oldFP: current, newFP: next),
                    verify(oldRaw, e.sig, cert)
                else { return .fail(.badChain) }
                seen.insert(next)
                current = next
            }
            if current != fpK { return .fail(.badChain) }
            viaChain = true
        }

        guard let msg = try? attestBytes(nonce: nonce, origin: origin, fp: fpK), verify(k, ans.sig, msg)
        else { return .fail(.badSig) }
        if !viaChain { return .pass }
        return context == .pair ? .fail(.repinAtPair) : .repin(newFP: fpK)
    }

    // MARK: - parts

    private struct Cert { let relayID: String, oldPubkey: String, newPubkey: String, sig: String }
    private struct Answer { let pubkey: String, sig: String, chain: [Cert] }

    private static let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".utf8)

    static func encode(_ d: Data) -> String {
        var out = [UInt8]()
        var acc = 0, bits = 0
        for b in d {
            acc = (acc << 8) | Int(b)
            bits += 8
            while bits >= 6 {
                bits -= 6
                out.append(alphabet[(acc >> bits) & 63])
            }
            acc &= (1 << bits) - 1
        }
        if bits > 0 { out.append(alphabet[(acc << (6 - bits)) & 63]) }
        return String(decoding: out, as: UTF8.self)
    }

    /// The bytes of canonical base64url text of exactly `count` bytes, or nil (wrong length, wrong characters, or spare bits set).
    private static func decode(_ s: String, count: Int) -> Data? {
        let chars = Array(s.utf8)
        var vals = [Int]()
        for c in chars {
            guard let i = alphabet.firstIndex(of: c) else { return nil }
            vals.append(i)
        }
        var out = Data()
        var acc = 0, bits = 0
        for v in vals {
            acc = (acc << 6) | v
            bits += 6
            if bits >= 8 {
                bits -= 8
                out.append(UInt8((acc >> bits) & 255))
                acc &= (1 << bits) - 1
            }
        }
        guard out.count == count, acc == 0 else { return nil }  // leftover bits are the spare bits: they must be 0
        return out
    }

    private static func decode32(_ s: String) -> Data? { s.utf8.count == 43 ? decode(s, count: 32) : nil }

    /// The group order L of Ed25519, little-endian: a signature whose S is not below it is refused, whatever CryptoKit would accept.
    private static let groupOrderLE: [UInt8] = [
        0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x10,
    ]

    private static func verify(_ rawKey: Data, _ sigText: String, _ message: Data) -> Bool {
        guard sigText.utf8.count == 86, let sig = decode(sigText, count: 64) else { return false }
        let s = Array(sig[32...])
        var below = false
        for i in stride(from: 31, through: 0, by: -1) where s[i] != groupOrderLE[i] {
            below = s[i] < groupOrderLE[i]
            break
        }
        guard below else { return false }  // S equal to L is not below it either
        guard let key = try? Curve25519.Signing.PublicKey(rawRepresentation: rawKey) else { return false }
        return key.isValidSignature(sig, for: message)
    }

    /// The y values (the key's 255 low bits, little-endian; the sign bit ignored) that are small-order points: y = 0 (order 4),
    /// 1 (the identity), p - 1 (order 2) and the two order-8 y's. Together with either x sign they are all 8 small-order points.
    /// The two order-8 values are SMALL_ORDER_Y in packages/protocol/src/bridge-attest.ts (written big-endian there, reversed here).
    private static let smallOrderY: Set<Data> = Set(
        [
            "0000000000000000000000000000000000000000000000000000000000000000",
            "0100000000000000000000000000000000000000000000000000000000000000",
            "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
            "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
            "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
        ].map { h in
            Data(
                stride(from: 0, to: h.count, by: 2).map { n in
                    let a = h.index(h.startIndex, offsetBy: n)
                    return UInt8(h[a..<h.index(a, offsetBy: 2)], radix: 16)!
                })
        })

    /// The raw 32 bytes of a canonical base64url key that is a usable Ed25519 public key, or nil: not an encoding with y >= p
    /// and not a small-order point, whatever CryptoKit would accept (it takes the identity with S = 0 as a signature of anything).
    private static func usableKey(_ text: String) -> Data? {
        guard let raw = decode32(text) else { return nil }
        var y = Array(raw)
        y[31] &= 0x7f
        if y[31] == 0x7f, y[1..<31].allSatisfy({ $0 == 0xff }), y[0] >= 0xed { return nil }  // y >= p = 2^255 - 19
        if smallOrderY.contains(Data(y)) { return nil }
        // On the curve by our own test, so the verdict never rests on whether CryptoKit's constructor throws; if it does, still refuse.
        guard Ed25519Point.isOnCurve(raw), (try? Curve25519.Signing.PublicKey(rawRepresentation: raw)) != nil else { return nil }
        return raw
    }

    /// Step 1: at most `bodyMax` raw bytes (checked before any decoding) and exactly {pubkey, sig, chain}, each chain entry
    /// exactly the cert fields, all strings; read by the strict reader.
    private static func parse(_ body: Data) -> Answer? {
        guard body.count <= bodyMax, case let .object(obj)? = StrictJSON.parse(body), obj.count == 3,
            case let .string(pubkey)? = obj["pubkey"], case let .string(sig)? = obj["sig"],
            case let .array(rawChain)? = obj["chain"]
        else { return nil }
        var chain = [Cert]()
        for item in rawChain {
            guard case let .object(e) = item, e.count == 4, case let .string(r)? = e["relay_id"],
                case let .string(o)? = e["old_pubkey"], case let .string(n)? = e["new_pubkey"], case let .string(s)? = e["sig"]
            else { return nil }
            chain.append(Cert(relayID: r, oldPubkey: o, newPubkey: n, sig: s))
        }
        return Answer(pubkey: pubkey, sig: sig, chain: chain)
    }
}
