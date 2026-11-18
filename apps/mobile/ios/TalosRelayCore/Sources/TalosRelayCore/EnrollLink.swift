import Foundation

/// The parser's errors. Raw values are the shared vector names (packages/protocol/src/enroll-link.ts).
public enum EnrollLinkError: String, Error, Equatable {
    /// Not a usable link: not https, userinfo, wrong path, not exactly one `#`, no host.
    case badLink = "bad_link"
    /// The code is empty or is not 26 Crockford base32 characters (first 0-7) after normalising.
    case noCode = "no_code"
    /// `fp` is not exactly 43 base64url characters, or a near-miss key (`FP`, `fpx`, `fp%3D`, `%66p`) is present.
    case badFp = "bad_fp"
    case dupFp = "dup_fp"
}

/// The iPhone app's own refusal, on top of the parser (docs/specs/BYOR.md section 10 (e)).
public enum EnrollPinRefusal: Error, Equatable {
    /// No `fp=`. The UI says: "this setup link is from an older Talos; update the Mac".
    case noFp
}

/// A parsed setup link: `https://<relay>/enroll#<code>&fp=<fp>`. Follows docs/specs/BYOR.md section 10 (f), which mirrors
/// packages/protocol/src/enroll-link.ts. The origin comes only from a native scan; this type never reads page content.
public struct EnrollLink: Equatable {
    public let origin: URL
    /// The normalised code: uppercase, no hyphens, I/L read as 1, O as 0 (a space inside is refused, as is anything not printable ASCII).
    public let code: String
    /// nil when the link has no `fp` (the parser accepts it; the app does not, see `requirePin()`).
    public let fp: String?

    /// The app refuses a link without a pin.
    public func requirePin() -> Result<String, EnrollPinRefusal> {
        fp.map { .success($0) } ?? .failure(.noFp)
    }

    public static func parse(_ link: String) -> Result<EnrollLink, EnrollLinkError> {
        // Only space, tab, CR and LF are trimmed from the ends. Then the whole link must be printable ASCII (0x21-0x7E), and
        // nothing is decoded, so the origin is exactly the characters the owner scanned.
        let link = link.trimmingCharacters(in: CharacterSet(charactersIn: " \t\r\n"))
        guard link.utf8.allSatisfy({ $0 >= 0x21 && $0 <= 0x7E }) else { return .failure(.badLink) }
        let parts = link.split(separator: "#", omittingEmptySubsequences: false)
        guard parts.count == 2, let origin = originOf(String(parts[0])) else { return .failure(.badLink) }

        let segments = parts[1].split(separator: "&", omittingEmptySubsequences: false).map(String.init)
        guard let code = normalizeCode(segments[0]) else { return .failure(.noCode) }
        var fp: String?
        for seg in segments.dropFirst() {
            let eq = seg.firstIndex(of: "=")
            let key = eq.map { String(seg[..<$0]) } ?? seg
            if key == "fp" {
                guard fp == nil else { return .failure(.dupFp) }
                guard let eq else { return .failure(.badFp) }
                fp = String(seg[seg.index(after: eq)...])
            } else if isNearMiss(seg) {
                return .failure(.badFp)
            }
        }
        if let fp, !isBase64URL43(fp) { return .failure(.badFp) }
        return .success(EnrollLink(origin: origin, code: code, fp: fp))
    }

    private static let crockford = Set("0123456789ABCDEFGHJKMNPQRSTVWXYZ")

    private static func normalizeCode(_ raw: String) -> String? {
        var out = ""
        for ch in raw.uppercased() where ch != "-" {
            out.append(ch == "I" || ch == "L" ? "1" : ch == "O" ? "0" : ch)
        }
        guard out.count == 26, out.allSatisfy({ crockford.contains($0) }), let first = out.first, "01234567".contains(first)
        else { return nil }
        return out
    }

    /// `https://host[:port]/enroll` with the path exactly `/enroll` (no query), as written: an ASCII DNS host with no
    /// percent signs, no `xn--` label, no trailing dot, no userinfo, and a port of 1 to 65535 or none. The host is lowercased.
    private static func originOf(_ s: String) -> URL? {
        guard s.hasPrefix("https://") else { return nil }
        let rest = s.dropFirst(8)
        guard let slash = rest.firstIndex(of: "/"), rest[slash...] == "/enroll" else { return nil }
        let authority = rest[..<slash]
        var host = String(authority)
        var port = ""
        if let colon = authority.lastIndex(of: ":") {
            host = String(authority[..<colon])
            port = String(authority[authority.index(after: colon)...])
            guard !port.isEmpty, port.count <= 5, !port.hasPrefix("0"), port.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }),
                  let n = Int(port), (1...65535).contains(n) else { return nil }
            port = n == 443 ? "" : ":\(n)"
        }
        host = host.lowercased()
        let labels = host.split(separator: ".", omittingEmptySubsequences: false)
        guard (1...253).contains(host.utf8.count), labels.allSatisfy(isHostLabel) else { return nil }
        // A browser reads a last label of digits or 0x-hex as a number (127.1, 0x7f.1, 2130706433); Foundation keeps it as
        // written. Accept that shape only as a plain dotted quad: 4 parts, each 0-255 with no leading zero.
        if let last = labels.last, last.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }) || isHexNumber(last) {
            guard labels.count == 4, labels.allSatisfy({ l in
                l.utf8.allSatisfy { $0 >= 48 && $0 <= 57 } && (l.count == 1 || !l.hasPrefix("0")) && (Int(l) ?? 256) <= 255
            }) else { return nil }
        }
        return URL(string: "https://\(host)\(port)")
    }

    private static func isHexNumber(_ l: Substring) -> Bool {
        l.hasPrefix("0x") && l.dropFirst(2).utf8.allSatisfy { ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 102) }
    }

    /// 1 to 63 of [a-z0-9-], no leading or trailing `-`, and never an `xn--` (punycode) label.
    private static func isHostLabel(_ l: Substring) -> Bool {
        let u = l.utf8
        return (1...63).contains(u.count) && u.first != 45 && u.last != 45 && !l.hasPrefix("xn--")
            && u.allSatisfy { ($0 >= 97 && $0 <= 122) || ($0 >= 48 && $0 <= 57) || $0 == 45 }
    }

    /// A key other than exactly `fp` that could be read as it: any key with a `%` (nothing is decoded), or any key starting
    /// with "fp" in any case (`fpx`, `fP`, `FP`). The key is the text before the first `=`, or the whole segment when there
    /// is none. Values of other keys are never looked at.
    private static func isNearMiss(_ seg: String) -> Bool {
        let key = seg.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)[0]
        if key.contains("%") { return true }
        return key.lowercased().hasPrefix("fp")
    }

    private static func isBase64URL43(_ s: String) -> Bool {
        let u = Array(s.utf8)
        return u.count == 43 && u.allSatisfy {
            ($0 >= 65 && $0 <= 90) || ($0 >= 97 && $0 <= 122) || ($0 >= 48 && $0 <= 57) || $0 == 45 || $0 == 95
        }
    }
}
