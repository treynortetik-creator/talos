import Foundation
import Testing

@testable import TalosShareCore

let goodSecret = "talos_share_" + String(repeating: "A", count: 43)

func token(_ scopes: Set<ShareScope> = [.text]) -> ShareToken {
    ShareToken(secret: goodSecret, scopes: scopes)!
}

let relay = URL(string: "https://relay.example.com")!

/// A scratch directory per test, removed by the caller's `defer`.
func scratch() throws -> URL {
    let d = FileManager.default.temporaryDirectory.appendingPathComponent("tsc-test-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
    return d
}

func makeFile(_ dir: URL, name: String = "a.bin", bytes: Int) throws -> URL {
    let u = dir.appendingPathComponent(name)
    FileManager.default.createFile(atPath: u.path, contents: nil)
    let h = try FileHandle(forWritingTo: u)
    defer { try? h.close() }
    var left = bytes
    let chunk = Data((0..<65_536).map { UInt8($0 & 0xff) })
    while left > 0 {
        let n = min(left, chunk.count)
        try h.write(contentsOf: chunk.prefix(n))
        left -= n
    }
    return u
}

struct Fixture: Decodable {
    let status: Int
    let headers: [String: String]
    let body: String

    static func load(_ name: String) throws -> Fixture {
        let url = Bundle.module.url(forResource: "Fixtures/\(name)", withExtension: "json")!
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    func response(for url: URL) -> (Data, URLResponse) {
        let r = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        return (Data(body.utf8), r)
    }
}

/// Records what the client asked for and answers with a canned reply. Reads the body file at call time, because the
/// client deletes it afterwards.
final class MockSession: URLSessionProtocol, @unchecked Sendable {
    struct Call { let request: URLRequest; let body: Data; let bodyPath: String }
    private let lock = NSLock()
    private var _calls: [Call] = []
    var calls: [Call] { lock.withLock { _calls } }
    let reply: @Sendable (URLRequest) throws -> (Data, URLResponse)

    init(_ reply: @escaping @Sendable (URLRequest) throws -> (Data, URLResponse)) { self.reply = reply }
    convenience init(fixture: String) throws {
        let f = try Fixture.load(fixture)
        self.init { f.response(for: $0.url!) }
    }

    func upload(for request: URLRequest, fromFile fileURL: URL) async throws -> (Data, URLResponse) {
        let body = try Data(contentsOf: fileURL)
        lock.withLock { _calls.append(Call(request: request, body: body, bodyPath: fileURL.path)) }
        return try reply(request)
    }
}
