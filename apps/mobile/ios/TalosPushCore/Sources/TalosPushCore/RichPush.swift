import CryptoKit
import Foundation

// Rich notifications on the phone (docs/IOS-PUSH.md "Message text and quick actions"). Everything here is pure: no UIKit, no
// Keychain, no network, so `swift test` runs it on any Mac. The notification extension opens a seal with it, and the app signs
// a Reply or an Approve with it. packages/protocol/src/push-rich.ts is the other half; RichPushTests reads the vectors that file's
// generator writes (packages/protocol/fixtures/push-rich), so a change on either side that the other does not follow goes red.

public enum Base64URL {
    public static func encode(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public static func decode(_ s: String) -> Data? {
        guard s.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else { return nil }
        var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while t.count % 4 != 0 { t += "=" }
        return Data(base64Encoded: t)
    }
}

/// What the relay sealed for one push (`RichContent` in push-rich.ts). Unknown fields are ignored; a field of the wrong type
/// makes the whole seal unusable, and the notification stays the fixed phrase Apple delivered.
public struct RichContent: Equatable, Sendable {
    public let subtitle: String?
    public let body: String
    public let kind: String
    public let threadId: String?
    public let cardId: String?
    public let risk: String?
    public let payloadHash: String?
}

public enum RichPush {
    public static let replyCategory = "TALOS_REPLY"
    public static let cardLowCategory = "TALOS_CARD_LOW"
    public static let replyActionId = "TALOS_ACT_REPLY"
    public static let approveLowActionId = "TALOS_ACT_APPROVE_LOW"
    /// The HKDF info string, the same bytes as SEAL_INFO.
    static let sealInfo = "talos-push/v1 aes-256-gcm"
    public static let replyMaxChars = 4000

    /// What the relay and the phone both bind a seal to: the device, the kind of push, the card (if any) and a random push id.
    public static func sealAad(deviceId: String, kind: String, cardId: String?, pushId: String) -> Data {
        Data("talos-push/v1|\(deviceId)|\(kind)|\(cardId ?? "")|\(pushId)".utf8)
    }

    /// Opens `talos.enc`. Returns nil for anything that is not a seal made for THIS phone, device, kind and card: a wrong key, a
    /// changed id, a lifted seal, a short or garbled field. It never throws and never returns partial text.
    public static func open(envelope: [String: Any], key: P256.KeyAgreement.PrivateKey, deviceId: String, kind: String, cardId: String?)
        -> RichContent?
    {
        guard envelope["v"] as? Int == 1,
              let pushId = envelope["id"] as? String, pushId.count == 22,
              let epkText = envelope["epk"] as? String, let epk = Base64URL.decode(epkText), epk.count == 65, epk[0] == 4,
              let ivText = envelope["iv"] as? String, let iv = Base64URL.decode(ivText), iv.count == 12,
              let ctText = envelope["ct"] as? String, let ct = Base64URL.decode(ctText), ct.count > 16
        else { return nil }
        do {
            let peer = try P256.KeyAgreement.PublicKey(x963Representation: epk)
            let secret = try key.sharedSecretFromKeyAgreement(with: peer)
            let aesKey = secret.hkdfDerivedSymmetricKey(using: SHA256.self, salt: epk, sharedInfo: Data(sealInfo.utf8), outputByteCount: 32)
            let box = try AES.GCM.SealedBox(
                nonce: AES.GCM.Nonce(data: iv), ciphertext: ct.prefix(ct.count - 16), tag: ct.suffix(16))
            let plain = try AES.GCM.open(box, using: aesKey, authenticating: sealAad(deviceId: deviceId, kind: kind, cardId: cardId, pushId: pushId))
            return content(from: plain)
        } catch {
            return nil
        }
    }

    static func content(from plain: Data) -> RichContent? {
        guard let json = try? JSONSerialization.jsonObject(with: plain) as? [String: Any],
              json["v"] as? Int == 1, let body = json["b"] as? String, let kind = json["k"] as? String else { return nil }
        func opt(_ k: String) -> String?? {
            guard let v = json[k] else { return .some(nil) }
            guard let s = v as? String else { return nil }
            return .some(s)
        }
        guard let s = opt("s"), let t = opt("t"), let c = opt("c"), let r = opt("r"), let h = opt("h") else { return nil }
        return RichContent(subtitle: s, body: body, kind: kind, threadId: t, cardId: c, risk: r, payloadHash: h)
    }

    /// The hash of everything the notification displayed: the subtitle (the thread name, or none) and the body
    /// (`shownHash` in push-rich.ts). The subtitle's UTF-8 length goes first so it cannot run into the body.
    public static func shownHash(_ displayed: String, subtitle: String? = nil) -> String {
        let sub = subtitle ?? ""
        let digest = SHA256.hash(data: Data("talos-shown/v2\n\(sub.utf8.count)\n\(sub)\n\(displayed)".utf8))
        return "sha256:" + digest.map { String(format: "%02x", $0) }.joined()
    }

    /// Which buttons this notification gets once it is open. A Reply needs a thread to go to. An Approve is offered only for a
    /// low-risk card that arrived with its id and hash (the relay sends those only when the text IS the whole card). Anything
    /// else keeps the category Apple delivered (Open, or the card's Open / Approve which opens the app).
    public static func category(for c: RichContent) -> String? {
        switch c.kind {
        case "reply": return c.threadId != nil ? replyCategory : nil
        case "card": return c.cardId != nil && c.risk == "low" && c.payloadHash != nil ? cardLowCategory : nil
        default: return nil
        }
    }

    // MARK: acting

    /// A ULID (Crockford base32, 48-bit time then 80 random bits). One per button press; a retry reuses it.
    public static func newActId(nowMs: UInt64 = UInt64(Date().timeIntervalSince1970 * 1000), random: () -> UInt8 = { UInt8.random(in: 0...255) }) -> String {
        let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")
        var out = [Character]()
        var t = nowMs
        for _ in 0..<10 { out.append(alphabet[Int(t & 31)]); t >>= 5 }
        out.reverse()
        var bits: UInt32 = 0, have = 0
        var chars = [Character]()
        while chars.count < 16 {
            bits = (bits << 8) | UInt32(random()); have += 8
            while have >= 5 && chars.count < 16 { have -= 5; chars.append(alphabet[Int((bits >> UInt32(have)) & 31)]) }
        }
        return String(out + chars)
    }

    /// The fields of a stored grant the phone needs. nil when it is not a grant for this build to use.
    public struct GrantInfo: Equatable, Sendable {
        public let deviceId: String
        public let osig: String
        public let expMs: Double
        public let scopes: [String]
    }

    public static func grantInfo(_ grantJson: String) -> GrantInfo? {
        guard let json = try? JSONSerialization.jsonObject(with: Data(grantJson.utf8)) as? [String: Any],
              json["type"] as? String == "native.grant", let device = json["device_id"] as? String,
              let osig = json["osig"] as? String, osig.count == 86, let exp = json["exp"] as? String,
              let scopes = json["scopes"] as? [String], let expDate = iso(exp) else { return nil }
        return GrantInfo(deviceId: device, osig: osig, expMs: expDate.timeIntervalSince1970 * 1000, scopes: scopes)
    }

    static func iso(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: s) ?? ISO8601DateFormatter().date(from: s)
    }

    public enum Act: Equatable, Sendable {
        case reply(threadId: String, text: String)
        case approve(cardId: String, payloadHash: String, shown: String)

        var scope: String {
            switch self { case .reply: return "reply"; case .approve: return "approve_low" }
        }
        /// JSON with sorted keys; the Mac parses it, so only the content matters, and the signature covers these exact bytes.
        var bodyJson: String {
            let dict: [String: String]
            switch self {
            case let .reply(thread, text): dict = ["a": "reply", "thread_id": thread, "text": text]
            case let .approve(card, hash, shown): dict = ["a": "approve", "card_id": card, "payload_hash": hash, "shown": shown]
            }
            let data = (try? JSONSerialization.data(withJSONObject: dict, options: [.sortedKeys, .withoutEscapingSlashes])) ?? Data()
            return String(decoding: data, as: UTF8.self)
        }
    }

    public enum ActError: Error, Equatable { case noGrant, grantExpired, noScope, empty, tooLong }

    /// The exact string that is signed (`actSigningInput`).
    public static func actSigningInput(deviceId: String, id: String, ts: String, grantOsig: String, body: String) -> String {
        "talos-act/v1\n\(deviceId)\n\(id)\n\(ts)\n\(grantOsig)\n\(body)"
    }

    /// Builds and signs the frame `POST /api/native/act` takes. The grant travels as the exact string the relay holds. Nothing
    /// is signed for a grant that has run out, a scope it does not carry, a blank Reply or one past the limit.
    public static func signAct(_ act: Act, grantJson: String, id: String, now: Date, key: P256.Signing.PrivateKey) throws -> [String: String] {
        guard let g = grantInfo(grantJson) else { throw ActError.noGrant }
        guard g.expMs > now.timeIntervalSince1970 * 1000 else { throw ActError.grantExpired }
        guard g.scopes.contains(act.scope) else { throw ActError.noScope }
        if case let .reply(_, text) = act {
            if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { throw ActError.empty }
            if text.count > replyMaxChars { throw ActError.tooLong }
        }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let ts = f.string(from: now)
        let body = act.bodyJson
        let input = actSigningInput(deviceId: g.deviceId, id: id, ts: ts, grantOsig: g.osig, body: body)
        let sig = try key.signature(for: Data(input.utf8))
        return [
            "v": "1", "id": id, "ts": ts, "type": "native.act", "device_id": g.deviceId, "grant": grantJson, "body": body,
            "asig": Base64URL.encode(sig.rawRepresentation),
        ]
    }

    /// The JSON the relay parses: `v` is a number, everything else a string.
    public static func wireJson(_ frame: [String: String]) -> Data {
        var obj: [String: Any] = frame
        obj["v"] = 1
        return (try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys, .withoutEscapingSlashes])) ?? Data()
    }

    // MARK: what the app does with a button press

    /// True when the grant names exactly these two public keys.
    public static func grantNamesKeys(_ grantJson: String, encPub: String, actPub: String) -> Bool {
        guard let json = try? JSONSerialization.jsonObject(with: Data(grantJson.utf8)) as? [String: Any], grantInfo(grantJson) != nil
        else { return false }
        return json["enc_pub"] as? String == encPub && json["act_pub"] as? String == actPub
    }

    /// The action a button press asks for, from what the extension put in `userInfo["talos_rich"]` and the typed text.
    /// nil when the notification does not carry what that button needs (so nothing is signed for a guess).
    public static func act(for action: PushCore.QuickAction, userInfo: [AnyHashable: Any], userText: String?) -> Act? {
        guard let rich = userInfo["talos_rich"] as? [String: String] else { return nil }
        switch action {
        case .reply:
            guard let thread = rich["t"], let text = userText else { return nil }
            return .reply(threadId: thread, text: text)
        case .approveLow:
            guard let card = rich["c"], let hash = rich["h"], let shown = rich["shown"] else { return nil }
            return .approve(cardId: card, payloadHash: hash, shown: shown)
        }
    }

    public enum Outcome: Equatable, Sendable {
        case done
        /// Worth one more try with the same id (no signal, a busy server).
        case retry
        /// The owner is told, in these words, and nothing more is tried.
        case failed(String)
    }

    /// `status` is the HTTP status (nil when no answer came), `code` the relay's `error` field if it sent one.
    public static func outcome(status: Int?, code: String?) -> Outcome {
        guard let status else { return .retry }
        if (200..<300).contains(status) { return .done }
        if status == 408 || status == 429 || status >= 500 { return .retry }
        switch code ?? "" {
        case "mac_update_needed": return .failed("Update Talos on your Mac to use notification buttons.")
        case "stepup_required", "open_in_app", "card_hash_mismatch": return .failed("This one needs you to open Talos.")
        case "act_stale", "act_future", "expired": return .failed("That took too long. Open Talos and try again.")
        case "grant_not_current", "device_not_trusted", "scope", "bad_grant", "bad_signature", "bad_act_signature", "grant_mismatch":
            return .failed("Notification buttons need Talos opened once to renew. Open Talos.")
        case "unknown_thread": return .failed("That thread is gone. Open Talos.")
        case "replay": return .failed("That tap was already used. Open Talos to check.")
        default:
            return (code ?? "").hasPrefix("card_")
                ? .failed("That card was already handled or has changed. Open Talos.")
                : .failed("Talos couldn't send that. Open Talos and try again.")
        }
    }

    /// Where the frame goes: the relay origin compiled into the build, never anything from the notification.
    public static func actURL(relay: URL) -> URL? {
        guard relay.scheme == "https", relay.host != nil,
              var c = URLComponents(url: relay, resolvingAgainstBaseURL: false) else { return nil }
        c.path = "/api/native/act"; c.query = nil; c.fragment = nil
        return c.url
    }
}
