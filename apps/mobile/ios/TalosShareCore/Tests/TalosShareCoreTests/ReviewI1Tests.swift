// Regression tests for the share extension core. Tests marked FAIL pin bugs that were found; tests marked GUARD are probes that
// held and stay as regression guards.
import Darwin
import Foundation
import Testing

@testable import TalosShareCore

// MARK: - Contract with the relay's POST /api/share (packages/protocol/src/share.ts, apps/relay/src/core/share.ts)

@Suite("Review I1: payload vs relay contract")
struct ReviewI1ContractTests {
    // FAIL (R1). The relay's `url` is `HttpsUrl` (max 2000, http(s), no whitespace). `cleanFields` MOVES a url that fails
    // that check into `text` as "<url>\n<text>", then `SharePostBody` caps text at 32,000. `validate` never looks at
    // `url`, so a share it calls valid gets a 400 `bad_request` from the relay. Its doc comment says it checks
    // "Everything the relay would refuse with a 400".
    @Test func aURLTheRelayWillFoldIntoTextCountsAgainstTheTextLimit() {
        let longURL = "https://example.com/" + String(repeating: "a", count: 2_000)  // 2,020 > HttpsUrl max 2000
        let p = SharePayload(text: String(repeating: "t", count: 31_000), url: longURL)
        #expect(throws: ShareRefusal.self) { try p.validate(scopes: [.text]) }
    }

    @Test func aNonWebURLPlusTextNearTheLimitIsRefusedLocally() {
        // "not a url" fails HttpsUrl, so the relay sends text = "not a url\n" + 31,995 chars = 32,005 > 32,000.
        let p = SharePayload(text: String(repeating: "t", count: 31_995), url: "not a url")
        #expect(throws: ShareRefusal.self) { try p.validate(scopes: [.text]) }
    }

    // FAIL (R2). The relay keeps only file parts with `size > 0` (share.ts parseShare). A zero-byte file counts as content
    // here, so a file-only share of an empty file gets 400 `empty_share`, and text + empty file is a 202 where the
    // file silently vanishes.
    @Test func aZeroByteFileIsNotContent() throws {
        let d = try scratch(); defer { try? FileManager.default.removeItem(at: d) }
        let empty = ShareFile(url: try makeFile(d, name: "empty.png", bytes: 0), filename: "empty.png", mimeType: "image/png")
        #expect(throws: ShareRefusal.self) { try SharePayload(files: [empty]).validate(scopes: [.text, .files]) }
    }

    // FAIL (R4, low). `safeFilename` cuts at 200 Characters (grapheme clusters). One cluster can hold any number of
    // combining marks, so a crafted name is unbounded in bytes. The relay's `cleanName` cuts at 200 UTF-16 units.
    @Test func aCraftedFilenameIsBoundedInBytes() {
        let zalgo = "a" + String(repeating: "\u{0301}", count: 50_000) + ".png"
        let safe = MultipartWriter.safeFilename(zalgo)
        #expect(safe.utf8.count <= 1_024, "filename header is \(safe.utf8.count) bytes")
    }

    // GUARD. The filename is only ever a header value: nothing is created from it, so `../` cannot escape locally.
    @Test func aTraversalFilenameCreatesNothingOutsideTheDestination() throws {
        let d = try scratch(); defer { try? FileManager.default.removeItem(at: d) }
        let inner = d.appendingPathComponent("inner"); try FileManager.default.createDirectory(at: inner, withIntermediateDirectories: true)
        let src = try makeFile(inner, name: "src.bin", bytes: 16)
        let out = inner.appendingPathComponent("body")
        let f = ShareFile(url: src, filename: "../escaped.txt", mimeType: "text/plain")
        try MultipartWriter(boundary: "B").write(SharePayload(files: [f]), to: out)
        #expect(!FileManager.default.fileExists(atPath: d.appendingPathComponent("escaped.txt").path))
        #expect(try FileManager.default.contentsOfDirectory(atPath: inner.path).sorted() == ["body", "src.bin"])
    }

    // GUARD. A symlink, a directory and a FIFO are refused before any byte is read.
    @Test func nonRegularFilesAreRefused() throws {
        let d = try scratch(); defer { try? FileManager.default.removeItem(at: d) }
        let target = try makeFile(d, name: "real", bytes: 4)
        let link = d.appendingPathComponent("link")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)
        let fifo = d.appendingPathComponent("fifo"); #expect(mkfifo(fifo.path, 0o600) == 0)
        for u in [link, d, fifo] {
            let p = SharePayload(files: [ShareFile(url: u, filename: "x", mimeType: "image/png")])
            #expect(throws: ShareRefusal.fileUnreadable) { try p.validate(scopes: [.text, .files]) }
        }
    }
}

// MARK: - Memory: the share extension has a hard memory ceiling (spec 6.1 "never load a 20 MB video into memory")

private func footprintBytes() -> Int64 {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
    let kr = withUnsafeMutablePointer(to: &info) {
        $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
    }
    return kr == KERN_SUCCESS ? Int64(info.phys_footprint) : -1
}

@Suite("Review I1: streaming memory", .serialized)
struct ReviewI1MemoryTests {
    // Four 20 MiB files must stream through without the process growing by anything like 80 MiB.
    @Test func fourMaxFilesStreamWithoutHoldingThemInMemory() throws {
        let d = try scratch(); defer { try? FileManager.default.removeItem(at: d) }
        let files = try (0..<4).map { i in
            ShareFile(url: try makeFile(d, name: "v\(i).mp4", bytes: Int(ShareLimits.fileBytes)), filename: "v\(i).mp4", mimeType: "video/mp4")
        }
        let before = footprintBytes()
        var peak = before
        let out = d.appendingPathComponent("body")
        try MultipartWriter().write(SharePayload(files: files), to: out)
        peak = max(peak, footprintBytes())
        let grew = (peak - before) / (1024 * 1024)
        #expect(grew < 32, "footprint grew \(grew) MiB writing an 80 MiB body")
    }
}

// MARK: - The default session against a real socket (the PR's redirect test calls the delegate method by hand)

/// A loopback pair: `redirector` answers every POST with 307 to `sink`; `sink` counts what reaches it.
private final class RedirectRig: @unchecked Sendable {
    let proc = Process()
    let redirector: URL, sink: URL
    static let script = #"""
import http.server, json, sys, threading
hits = []
class Sink(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        b = json.dumps(hits).encode(); self.send_response(200); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0); self.rfile.read(n)
        hits.append({"auth": self.headers.get("Authorization") or ""})
        b = b'{"share_id":"SINK"}'; self.send_response(202); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
sink = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Sink)
class Redir(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0); self.rfile.read(n)
        self.send_response(307); self.send_header("Location", "http://127.0.0.1:%d/api/share" % sink.server_port); self.send_header("Content-Length", "0"); self.end_headers()
red = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Redir)
threading.Thread(target=sink.serve_forever, daemon=True).start()
threading.Thread(target=red.serve_forever, daemon=True).start()
print(red.server_port, sink.server_port, flush=True)
sys.stdin.read()
"""#

    init() throws {
        let out = Pipe(), inp = Pipe()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
        proc.arguments = ["-I", "-c", Self.script]
        proc.standardOutput = out
        proc.standardInput = inp
        try proc.run()
        var line = Data()
        while !line.contains(0x0a), let b = try out.fileHandleForReading.read(upToCount: 1), !b.isEmpty { line += b }
        let ports = String(decoding: line, as: UTF8.self).split(separator: " ").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        guard ports.count == 2 else { throw URLError(.cannotConnectToHost) }
        redirector = URL(string: "http://127.0.0.1:\(ports[0])")!
        sink = URL(string: "http://127.0.0.1:\(ports[1])")!
    }

    func sinkHits() async throws -> [[String: String]] {
        let (d, _) = try await URLSession(configuration: .ephemeral).data(from: sink)
        return (try JSONSerialization.jsonObject(with: d) as? [[String: String]]) ?? []
    }

    func stop() { proc.terminate(); proc.waitUntilExit() }
}

@Suite("Review I1: default session on a real socket")
struct ReviewI1RedirectTests {
    // GUARD. Proves through URLSession itself (not a hand call of the delegate method) that the per-task delegate is
    // consulted for `upload(for:fromFile:delegate:)`: the 307 is returned, and the Bearer never reaches the sink.
    @Test func aRealRedirectIsNotFollowedAndTheBearerStaysHome() async throws {
        let rig = try RedirectRig(); defer { rig.stop() }
        let r = await ShareClient.send(
            SharePayload(text: "x"), token: token(), relayHost: rig.redirector, session: ShareURLSession(), allowLoopbackHTTP: true)
        #expect(r == .rejected(status: 307, code: nil))
        let hits = try await rig.sinkHits()
        #expect(hits.isEmpty, "the sink got \(hits.count) request(s)")
        #expect(!hits.contains { $0["auth"]?.contains("talos_share_") == true })
    }
}

// MARK: - Live, against the repo's own relay (./test.sh --live). Lives in LiveRelayTests' serialized suite so it never
// races that suite's item counts.

private func liveItems() async throws -> [[String: Any]] {
    let c = try #require(LiveConfig.current)
    let (d, _) = try await URLSession.shared.data(from: URL(string: c.control + "/items")!)
    return try #require(JSONSerialization.jsonObject(with: d) as? [[String: Any]])
}

extension LiveRelayTests {
    // FAIL (R1, live). A share `validate` passes gets the relay's 400.
    @Test func reviewI1_longURLWithTextIsNotARelay400() async throws {
        let longURL = "https://example.com/" + String(repeating: "a", count: 2_000)
        let r = await ShareClient.send(
            SharePayload(text: String(repeating: "t", count: 31_000), url: longURL),
            token: tok(cfg!.tokens.text, [.text]), relayHost: host, session: SpreadSession(), allowLoopbackHTTP: true)
        if case .rejected(400, _) = r { Issue.record("validate() passed it, the relay answered \(r)") }
    }

    // FAIL (R2, live). Text + an empty file: 202, and the file is gone without a word.
    @Test func reviewI1_anEmptyFileIsNotSilentlyDropped() async throws {
        let d = try scratch(); defer { try? FileManager.default.removeItem(at: d) }
        let empty = try makeFile(d, name: "empty.png", bytes: 0)
        let r = await ShareClient.send(
            SharePayload(text: "with an empty file", files: [ShareFile(url: empty, filename: "empty.png", mimeType: "image/png")]),
            token: tok(cfg!.tokens.files, [.text, .files]), relayHost: host, session: SpreadSession(), allowLoopbackHTTP: true)
        guard case .sent(let id) = r else { return }  // a local refusal is an acceptable fix
        let item = try #require(try await liveItems().last { $0["share_id"] as? String == id })
        let atts = ((item["message"] as? [String: Any])?["attachments"] as? [[String: Any]]) ?? []
        #expect(atts.count == 1, "sent(\(id ?? "-")) but the relay kept \(atts.count) of 1 file")
    }

    // GUARD (live). The biggest text-only share validate allows (CJK = 3 UTF-8 bytes per UTF-16 unit) fits the relay's
    // 128 KiB text-token body cap.
    @Test func reviewI1_theLargestValidTextShareFitsTheTextBodyCap() async {
        let r = await ShareClient.send(
            SharePayload(
                text: String(repeating: "語", count: 32_000), url: "https://example.com/" + String(repeating: "b", count: 1_900),
                title: String(repeating: "題", count: 300), note: String(repeating: "注", count: 4_000)),
            token: tok(cfg!.tokens.text, [.text]), relayHost: host, session: SpreadSession(), allowLoopbackHTTP: true)
        if case .sent = r {} else { Issue.record("max CJK share got \(r)") }
    }

    // GUARD (live). Path traversal and a percent-encoded CRLF in a filename: the relay stores a bare, clean name.
    @Test func reviewI1_traversalAndEncodedCRLFNamesAreStoredClean() async throws {
        let d = try scratch(); defer { try? FileManager.default.removeItem(at: d) }
        let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")!
        let u = d.appendingPathComponent("x.png"); try png.write(to: u)
        let r = await ShareClient.send(
            SharePayload(files: [
                ShareFile(url: u, filename: "../../../etc/passwd", mimeType: "image/png"),
                ShareFile(url: u, filename: "a%0D%0AX-Evil: 1.png", mimeType: "image/png"),
            ]),
            token: tok(cfg!.tokens.files, [.text, .files]), relayHost: host, session: SpreadSession(), allowLoopbackHTTP: true)
        guard case .sent(let id) = r else { Issue.record("got \(r)"); return }
        let item = try #require(try await liveItems().last { $0["share_id"] as? String == id })
        let names = (((item["message"] as? [String: Any])?["attachments"] as? [[String: Any]]) ?? []).compactMap { $0["name"] as? String }
        #expect(names.count == 2)
        for n in names { #expect(!n.contains("/") && !n.contains("\\") && !n.contains("\r") && !n.contains("\n"), "stored \(n)") }
    }
}
