import Foundation
import Testing

@testable import TalosShareCore

/// Splits a multipart body on its boundary and returns (headers, content) per part, byte-exact on the content.
private func parts(_ body: Data, boundary: String) -> [(headers: [String], content: Data)]? {
    let crlf = Data("\r\n".utf8), delim = Data("--\(boundary)".utf8)
    guard body.starts(with: delim + crlf), body.suffix(delim.count + 4) == Data("\r\n--\(boundary)--\r\n".utf8).suffix(delim.count + 4) else { return nil }
    var out: [(headers: [String], content: Data)] = []
    let sep = crlf + delim
    var rest = body.dropFirst(delim.count + 2)
    while true {
        guard let hEnd = rest.range(of: crlf + crlf) else { return nil }
        let headers = String(decoding: rest[rest.startIndex..<hEnd.lowerBound], as: UTF8.self).components(separatedBy: "\r\n")
        let after = rest[hEnd.upperBound...]
        guard let next = after.range(of: sep) else { return nil }
        out.append((headers, Data(after[after.startIndex..<next.lowerBound])))
        let tail = after[next.upperBound...]
        if tail.starts(with: Data("--\r\n".utf8)) { return out }
        guard tail.starts(with: crlf) else { return nil }
        rest = tail.dropFirst(2)
    }
}

@Suite("MultipartWriter")
struct MultipartWriterTests {
    func body(_ p: SharePayload, boundary: String = "B0UNDARY") throws -> (Data, [(headers: [String], content: Data)]) {
        let d = try scratch(); defer { try? FileManager.default.removeItem(at: d) }
        let out = d.appendingPathComponent("body")
        let n = try MultipartWriter(boundary: boundary).write(p, to: out)
        let data = try Data(contentsOf: out)
        #expect(Int64(data.count) == n)
        return (data, try #require(parts(data, boundary: boundary)))
    }

    @Test func fieldsComeOutByTheRelaysNames() throws {
        let (_, ps) = try body(SharePayload(text: "t", url: "https://example.com/", title: "ti", note: "no"))
        let names = ps.map { $0.headers.first { $0.hasPrefix("Content-Disposition") } ?? "" }
        #expect(names == [
            "Content-Disposition: form-data; name=\"text\"", "Content-Disposition: form-data; name=\"url\"",
            "Content-Disposition: form-data; name=\"title\"", "Content-Disposition: form-data; name=\"note\"",
        ])
        #expect(ps.map { String(decoding: $0.content, as: UTF8.self) } == ["t", "https://example.com/", "ti", "no"])
    }

    @Test func absentAndBlankFieldsAreOmittedAndNonASCIIIsUTF8() throws {
        let (_, ps) = try body(SharePayload(text: "héllo 日本 😀\r\nline2", url: nil, title: "", note: nil))
        #expect(ps.count == 1)
        #expect(String(decoding: ps[0].content, as: UTF8.self) == "héllo 日本 😀\r\nline2")
    }

    @Test func fileNameWithQuoteAndCRLFCannotInjectAHeader() throws {
        let d = try scratch(); defer { try? FileManager.default.removeItem(at: d) }
        let f = ShareFile(url: try makeFile(d, bytes: 5), filename: "a\"b\r\nX-Evil: 1\r\n\r\nINJECT.png", mimeType: "image/png\r\nX-Evil2: 1")
        let (data, ps) = try body(SharePayload(files: [f]))
        #expect(ps.count == 1)
        let h = ps[0].headers
        #expect(h.count == 2)  // Content-Disposition and Content-Type, nothing else
        #expect(h.allSatisfy { !$0.hasPrefix("X-Evil") })
        let cd = try #require(h.first { $0.hasPrefix("Content-Disposition") })
        #expect(cd.hasPrefix("Content-Disposition: form-data; name=\"file\"; filename=\""))
        let name = String(cd.dropFirst("Content-Disposition: form-data; name=\"file\"; filename=\"".count).dropLast())
        #expect(!name.contains("\"") && !name.contains("\r") && !name.contains("\n"))
        #expect(h.contains("Content-Type: application/octet-stream"))
        #expect(!String(decoding: data, as: UTF8.self).contains("\r\nX-Evil"))
        #expect(ps[0].content.count == 5)
    }

    @Test func emptyNameBecomesADefaultAndLongNamesAreCut() throws {
        let d = try scratch(); defer { try? FileManager.default.removeItem(at: d) }
        let u = try makeFile(d, bytes: 1)
        let (_, ps) = try body(SharePayload(files: [
            ShareFile(url: u, filename: "", mimeType: "image/png"),
            ShareFile(url: u, filename: String(repeating: "x", count: 600), mimeType: "image/png"),
        ]))
        let names = ps.map { $0.headers[0] }
        #expect(names[0].contains("filename=\"file\""))
        #expect(names[1].count < 400)
    }

    @Test func fileBytesSurviveExactly() throws {
        let d = try scratch(); defer { try? FileManager.default.removeItem(at: d) }
        let u = try makeFile(d, bytes: 1_000_003)  // not a multiple of any chunk size
        let (_, ps) = try body(SharePayload(files: [ShareFile(url: u, filename: "big.bin", mimeType: "application/octet-stream")]))
        #expect(ps[0].content == (try Data(contentsOf: u)))
    }

    @Test func aFileThatGrewPastTheLimitWhileStreamingStopsTheWrite() throws {
        let d = try scratch(); defer { try? FileManager.default.removeItem(at: d) }
        let u = try makeFile(d, bytes: 20 * 1024 * 1024 + 1)
        let out = d.appendingPathComponent("body")
        #expect(throws: ShareRefusal.fileTooLarge) {
            try MultipartWriter(boundary: "B").write(SharePayload(files: [ShareFile(url: u, filename: "f", mimeType: "video/mp4")]), to: out)
        }
    }

    @Test func aBoundaryInsideAFieldIsRefused() throws {
        let d = try scratch(); defer { try? FileManager.default.removeItem(at: d) }
        #expect(throws: ShareRefusal.badBoundary) {
            try MultipartWriter(boundary: "XYZ").write(SharePayload(text: "see --XYZ here"), to: d.appendingPathComponent("b"))
        }
    }

    @Test func boundariesAreRandomAndTheContentTypeCarriesIt() {
        let a = MultipartWriter(), b = MultipartWriter()
        #expect(a.boundary != b.boundary)
        #expect(a.boundary.count >= 32)
        #expect(a.contentType == "multipart/form-data; boundary=\(a.boundary)")
    }

    @Test func bodyFileIsPrivate() throws {
        let d = try scratch(); defer { try? FileManager.default.removeItem(at: d) }
        let out = d.appendingPathComponent("body")
        try MultipartWriter().write(SharePayload(text: "x"), to: out)
        let perms = try FileManager.default.attributesOfItem(atPath: out.path)[.posixPermissions] as? Int
        #expect(perms == 0o600)
    }
}
