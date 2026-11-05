import Foundation

/// Writes the V4.3 multipart body (`text`, `url`, `title`, `note`, then up to 4 `file` parts) to a file, so a 20 MB
/// video is copied in 64 KiB pieces and never held in memory. The caller uploads that file with `uploadTask(fromFile:)`.
public struct MultipartWriter: Sendable {
    public let boundary: String
    static let chunk = 64 * 1024

    /// A fresh 128-bit random boundary. Nothing a sender controls can predict it.
    public init() {
        var g = SystemRandomNumberGenerator()
        let hex = (0..<2).map { _ in String(UInt64.random(in: .min ... .max, using: &g), radix: 16) }
            .map { String(repeating: "0", count: 16 - $0.count) + $0 }.joined()
        boundary = "----TalosShare" + hex
    }

    init(boundary: String) { self.boundary = boundary }

    public var contentType: String { "multipart/form-data; boundary=\(boundary)" }

    /// Streams the body to `destination` (created 0600, removed again if the write fails). Returns its size in bytes.
    @discardableResult
    public func write(_ payload: SharePayload, to destination: URL) throws -> Int64 {
        let fm = FileManager.default
        try? fm.removeItem(at: destination)
        guard fm.createFile(atPath: destination.path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
            throw ShareRefusal.localIO
        }
        do {
            let out = try FileHandle(forWritingTo: destination)
            defer { try? out.close() }
            var total: Int64 = 0
            func put(_ s: String) throws {
                let d = Data(s.utf8)
                try out.write(contentsOf: d)
                total += Int64(d.count)
            }
            for (name, value) in [("text", payload.text), ("url", payload.url), ("title", payload.title), ("note", payload.note)] {
                guard let v = value, !v.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
                if v.contains(boundary) { throw ShareRefusal.badBoundary }
                try put("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(v)\r\n")
            }
            for f in payload.files {
                try put(
                    "--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(Self.safeFilename(f.filename))\"\r\n"
                        + "Content-Type: \(Self.safeMime(f.mimeType))\r\n\r\n")
                total += try Self.copy(f.url, into: out)
                try put("\r\n")
            }
            try put("--\(boundary)--\r\n")
            return total
        } catch {
            try? fm.removeItem(at: destination)
            throw (error as? ShareRefusal) ?? ShareRefusal.localIO
        }
    }

    /// Copies one file in chunks, counting what it really reads: a file that grew since `validate` still stops at 20 MiB.
    private static func copy(_ src: URL, into out: FileHandle) throws -> Int64 {
        guard let h = try? FileHandle(forReadingFrom: src) else { throw ShareRefusal.fileUnreadable }
        defer { try? h.close() }
        var n: Int64 = 0
        // Each chunk is an autoreleased NSData on Darwin: without a pool per chunk, all of them live until the caller's
        // pool drains, i.e. the whole file stays in memory after all.
        while try autoreleasepool(invoking: { () throws -> Bool in
            let piece: Data?
            do { piece = try h.read(upToCount: chunk) } catch { throw ShareRefusal.fileUnreadable }
            guard let d = piece, !d.isEmpty else { return false }
            n += Int64(d.count)
            if n > ShareLimits.fileBytes { throw ShareRefusal.fileTooLarge }
            try out.write(contentsOf: d)
            return true
        }) {}
        return n
    }

    /// No control characters (so no CR or LF), `"` written as %22 as HTML form encoding does, at most 200 UTF-16 units
    /// (the relay's `cleanName` cut), so at most 600 UTF-8 bytes. Counted in scalars, never grapheme clusters: one
    /// cluster can carry any number of combining marks.
    static func safeFilename(_ name: String) -> String {
        var cleaned = String.UnicodeScalarView()
        var units = 0
        for s in name.unicodeScalars where s.value >= 0x20 && s.value != 0x7f {
            let piece = s == "\"" ? "%22".unicodeScalars : String(s).unicodeScalars
            let w = piece.reduce(0) { $0 + UTF16.width($1) }
            if units + w > 200 { break }
            cleaned.append(contentsOf: piece)
            units += w
        }
        let cut = String(cleaned).trimmingCharacters(in: .whitespaces)
        return cut.isEmpty ? "file" : cut
    }

    /// `type/subtype` made of token characters, or `application/octet-stream`.
    static func safeMime(_ mime: String) -> String {
        let ok = mime.range(of: #"^[A-Za-z0-9!#$&^_.+-]{1,60}/[A-Za-z0-9!#$&^_.+-]{1,60}$"#, options: .regularExpression) != nil
        return ok ? mime.lowercased() : "application/octet-stream"
    }
}
