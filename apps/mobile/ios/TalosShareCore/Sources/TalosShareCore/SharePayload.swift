import Foundation

public enum ShareField: String, Sendable, Equatable {
    case text, note, title
}

/// Why a share was refused on the phone, before anything was sent.
public enum ShareRefusal: Error, Sendable, Equatable {
    case empty
    case fieldTooLong(ShareField)
    case filesNotAllowed
    case tooManyFiles
    case fileTooLarge
    case fileUnreadable
    /// A zero-byte file. The relay drops those parts, so it would vanish (or the share would be `empty_share`).
    case emptyFile
    case insecureRelay
    case badRelay
    case badBoundary
    case localIO
}

public struct ShareFile: Sendable, Equatable {
    public let url: URL
    public let filename: String
    public let mimeType: String
    public init(url: URL, filename: String, mimeType: String) {
        self.url = url
        self.filename = filename
        self.mimeType = mimeType
    }
}

public struct SharePayload: Sendable, Equatable {
    public var text: String?
    public var url: String?
    public var title: String?
    public var note: String?
    public var files: [ShareFile]

    public init(text: String? = nil, url: String? = nil, title: String? = nil, note: String? = nil, files: [ShareFile] = []) {
        self.text = text
        self.url = url
        self.title = title
        self.note = note
        self.files = files
    }

    /// Everything the relay would refuse with a 400, 403 or 413, checked on the phone first so a bad share costs nothing.
    /// Order: field lengths, then files (scope, count, size), then "is there anything to send".
    public func validate(scopes: Set<ShareScope>) throws {
        if Self.relayTextUTF16(text: text, url: url) > ShareLimits.textUTF16 { throw ShareRefusal.fieldTooLong(.text) }
        if (note?.utf16.count ?? 0) > ShareLimits.noteUTF16 { throw ShareRefusal.fieldTooLong(.note) }
        if (title?.utf16.count ?? 0) > ShareLimits.titleUTF16 { throw ShareRefusal.fieldTooLong(.title) }
        if !files.isEmpty {
            guard scopes.contains(.files) else { throw ShareRefusal.filesNotAllowed }
            guard files.count <= ShareLimits.maxFiles else { throw ShareRefusal.tooManyFiles }
            for f in files {
                guard let attrs = try? FileManager.default.attributesOfItem(atPath: f.url.path),
                    attrs[.type] as? FileAttributeType == .typeRegular,
                    let size = (attrs[.size] as? NSNumber)?.int64Value
                else { throw ShareRefusal.fileUnreadable }
                // The relay keeps only file parts with size > 0 (share.ts parseShare): say so instead of losing it.
                guard size > 0 else { throw ShareRefusal.emptyFile }
                guard size <= ShareLimits.fileBytes else { throw ShareRefusal.fileTooLarge }
            }
        }
        guard Self.filled(text) || Self.filled(url) || Self.filled(note) || !files.isEmpty else { throw ShareRefusal.empty }
    }

    private static func filled(_ s: String?) -> Bool { !(s ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    /// The length the relay's `text` will have. Its `cleanFields` (apps/relay/src/core/share.ts) drops blank fields, then
    /// moves a `url` that fails `HttpsUrl` into text as "<url>\n<text>" (or just "<url>"), and only then caps text at 32,000.
    static func relayTextUTF16(text: String?, url: String?) -> Int {
        let t = filled(text) ? text! : nil
        guard let u = url, filled(u), !isRelayWebURL(u) else { return t?.utf16.count ?? 0 }
        return u.utf16.count + (t.map { 1 + $0.utf16.count } ?? 0)
    }

    /// The relay's `HttpsUrl` (packages/protocol/src/ids.ts): at most 2,000 UTF-16 units, no whitespace (JavaScript `\s`)
    /// or control character, and WHATWG `new URL()` parses it with an http: or https: scheme. The WHATWG parse is
    /// approximated: after the scheme it accepts any path, query and fragment, so only the host can fail. That means a
    /// non-empty host with no forbidden code point, a valid port, and a valid IPv4 address when the last label is numeric.
    static func isRelayWebURL(_ u: String) -> Bool {
        guard u.utf16.count <= 2000 else { return false }
        if u.unicodeScalars.contains(where: { jsWhitespaceOrControl.contains($0.value) || ($0.value >= 0x2000 && $0.value <= 0x200a) }) {
            return false
        }
        let lower = u.lowercased()
        let rest: Substring
        if lower.hasPrefix("https:") { rest = u.dropFirst(6) } else if lower.hasPrefix("http:") { rest = u.dropFirst(5) } else { return false }
        let afterSlashes = rest.drop { $0 == "/" || $0 == "\\" }
        var authority = afterSlashes.prefix { !"/\\?#".contains($0) }
        if let at = authority.lastIndex(of: "@") { authority = authority[authority.index(after: at)...] }
        var host = authority
        var port: Substring = ""
        if host.hasPrefix("[") {
            guard let close = host.firstIndex(of: "]") else { return false }
            let inner = host[host.index(after: host.startIndex)..<close]
            guard !inner.isEmpty, inner.allSatisfy({ $0.isHexDigit || $0 == ":" || $0 == "." }) else { return false }
            let tail = host[host.index(after: close)...]
            if !tail.isEmpty { guard tail.first == ":" else { return false }; port = tail.dropFirst() }
            return validPort(port)
        }
        if let colon = host.firstIndex(of: ":") { port = host[host.index(after: colon)...]; host = host[..<colon] }
        guard validPort(port) else { return false }
        let decoded = String(host).removingPercentEncoding ?? String(host)
        guard !decoded.isEmpty, !decoded.unicodeScalars.contains(where: { forbiddenHost.contains($0.value) }) else { return false }
        return validIPv4IfNumeric(decoded.lowercased())
    }

    // JavaScript `\s` (minus U+2000-200A, checked inline) plus C0 controls and DEL.
    private static let jsWhitespaceOrControl: Set<UInt32> = Set(0x00...0x20).union([0x7f, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff])
    // WHATWG forbidden domain code points (C0 controls, space and DEL are already excluded above).
    private static let forbiddenHost: Set<UInt32> = Set("#%/:<>?@[\\]^|".unicodeScalars.map(\.value)).union(Set(0x00...0x20)).union([0x7f])

    private static func validPort(_ p: Substring) -> Bool {
        p.isEmpty || (p.allSatisfy { $0.isASCII && $0.isNumber } && (Int(p.drop { $0 == "0" }.prefix(6)) ?? 0) <= 65535)
    }

    /// WHATWG treats a host whose last label is a number as IPv4, and then every label must be a number in range.
    private static func validIPv4IfNumeric(_ host: String) -> Bool {
        var labels = host.split(separator: ".", omittingEmptySubsequences: false)
        if labels.count > 1, labels.last == "" { labels.removeLast() }
        func number(_ l: Substring) -> UInt64? {
            if l.isEmpty { return nil }
            if l.hasPrefix("0x") { let h = l.dropFirst(2); return h.isEmpty ? 0 : (h.count > 16 ? nil : UInt64(h, radix: 16)) }
            if l.count > 1, l.hasPrefix("0") { return l.count > 23 ? nil : UInt64(l.dropFirst(), radix: 8) }
            return l.count > 20 ? nil : UInt64(l, radix: 10)
        }
        guard let last = labels.last else { return true }
        let lastIsNumeric = (last.hasPrefix("0x") && last.dropFirst(2).allSatisfy(\.isHexDigit)) || (!last.isEmpty && last.allSatisfy { $0.isASCII && $0.isNumber })
        guard lastIsNumeric else { return true }
        guard labels.count <= 4 else { return false }
        let nums = labels.map(number)
        guard nums.allSatisfy({ $0 != nil }) else { return false }
        let n = nums.map { $0! }
        if n.dropLast().contains(where: { $0 > 255 }) { return false }
        return n.last! < (UInt64(1) << (8 * UInt64(5 - n.count)))
    }
}
