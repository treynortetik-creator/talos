import CoreGraphics
import Foundation
import Testing
@testable import TalosDesktopCore

/// A screen service that records what it was asked and answers what it is told to.
final class FakeScreenService: ScreenService, @unchecked Sendable {
  enum Call: Equatable {
    case shot(ScreenArea, [String]), input(ScreenInputRequest, [String]), apps, open(String, [String])
  }
  private let lock = NSLock()
  private var _calls: [Call] = []
  private var _spans: [(Double, Double)] = []
  var refusal: ScreenRefusal?
  var inputDelay: Double = 0
  var shotResult = ScreenShot(
    png: Data([1, 2, 3]), width: 4, height: 3, area: CGRect(x: 0, y: 0, width: 8, height: 6), shownApps: ["com.example.notes"],
    hiddenWindows: 2)
  var appsResult = [Fx.notes, ScreenApp(bundleID: nil, pid: 9, name: "Loose Tool")]
  var calls: [Call] { lock.withLock { _calls } }
  var spans: [(Double, Double)] { lock.withLock { _spans } }
  func note(_ s: Call) { lock.withLock { _calls.append(s) } }

  func shot(area: ScreenArea, allowed: ScreenAllowed) async throws(ScreenRefusal) -> ScreenShot {
    note(.shot(area, allowed.bundleIDs.sorted()))
    if let refusal { throw refusal }
    return shotResult
  }
  func input(_ request: ScreenInputRequest, allowed: ScreenAllowed) throws(ScreenRefusal) -> Int {
    let start = Date().timeIntervalSince1970
    note(.input(request, allowed.bundleIDs.sorted()))
    if inputDelay > 0 { usleep(useconds_t(inputDelay * 1_000_000)) }
    lock.withLock { _spans.append((start, Date().timeIntervalSince1970)) }
    if let refusal { throw refusal }
    return 1
  }
  func listApps() -> [ScreenApp] {
    note(.apps)
    return appsResult
  }
  func open(bundleID: String, allowed: ScreenAllowed) async throws(ScreenRefusal) {
    note(.open(bundleID, allowed.bundleIDs.sorted()))
    if let refusal { throw refusal }
  }
}

struct FixedAllowList: ScreenAllowListProvider {
  var apps: [ScreenAllowedApp]
  func allowedApps() -> [ScreenAllowedApp] { apps }
}

func answer(_ p: ScreenProtocol, _ line: String) async throws -> [String: Any] {
  let d = await p.answer(Data(line.utf8))
  return try #require((try JSONSerialization.jsonObject(with: d)) as? [String: Any], "\(String(decoding: d, as: UTF8.self))")
}

func errorOf(_ o: [String: Any]) -> (code: String?, text: String?, app: String?) {
  let e = o["error"] as? [String: Any]
  return (e?["code"] as? String, e?["text"] as? String, e?["app"] as? String)
}

@Suite("Screen socket protocol")
struct ScreenProtocolTests {
  let allow = FixedAllowList(apps: [ScreenAllowedApp(bundleID: "com.example.notes", teamID: "ABCDE12345")])

  @Test func eachOpReachesTheServiceWithTheAllowListAndAnswersItsShape() async throws {
    let f = FakeScreenService()
    let p = ScreenProtocol(service: f, allowList: allow, signing: FakeSigning())
    let shot = try await answer(p, #"{"v":1,"id":"a","op":"shot","area":{"kind":"region","x":1,"y":2,"width":3,"height":4}}"#)
    #expect(shot["ok"] as? Bool == true && shot["id"] as? String == "a")
    #expect(shot["png_base64"] as? String == Data([1, 2, 3]).base64EncodedString())
    #expect(shot["width"] as? Int == 4 && shot["height"] as? Int == 3 && shot["hidden_windows"] as? Int == 2)
    #expect(shot["shown_apps"] as? [String] == ["com.example.notes"])
    #expect((shot["area"] as? [String: Any])?["width"] as? Double == 8)
    for line in [
      #"{"op":"click","x":10,"y":20,"button":"right","count":2}"#, #"{"op":"type","text":"hi"}"#, #"{"op":"key","keys":"cmd+s"}"#,
      #"{"op":"scroll","x":5,"y":6,"dy":-3}"#,
    ] {
      let o = try await answer(p, line)
      #expect(o["ok"] as? Bool == true && o["events"] as? Int == 1, "\(line)")
    }
    let apps = try await answer(p, #"{"op":"apps"}"#)
    let list = try #require(apps["apps"] as? [[String: Any]])
    #expect(list.count == 2)
    #expect(list[0]["bundle_id"] as? String == "com.example.notes" && list[0]["allowed"] as? Bool == true)
    #expect(list[1]["bundle_id"] == nil && list[1]["allowed"] as? Bool == false)
    #expect(try await answer(p, #"{"op":"open_app","bundle_id":"com.example.notes"}"#)["ok"] as? Bool == true)
    #expect(try await answer(p, #"{"op":"shot"}"#)["ok"] as? Bool == true)
    let n = ["com.example.notes"]
    #expect(
      f.calls == [
        .shot(.region(CGRect(x: 1, y: 2, width: 3, height: 4)), n), .input(.click(CGPoint(x: 10, y: 20), button: .right, count: 2), n),
        .input(.type("hi"), n), .input(.key("cmd+s"), n), .input(.scroll(at: CGPoint(x: 5, y: 6), dx: 0, dy: -3), n), .apps,
        .open("com.example.notes", n), .shot(.full, n),
      ])
  }

  /// The texts the owner and the agent read, from the real ScreenCore (fake macOS underneath), word for word.
  @Test func eachRefusalTravelsAsItsCodeAndItsText() async throws {
    let noScreen = ScreenProtocol(service: Fx.core(permissions: FakePermissions(screen: false)), allowList: allow, signing: FakeSigning())
    let e1 = errorOf(try await answer(noScreen, #"{"op":"shot"}"#))
    #expect(e1.code == "screen_recording_not_granted")
    #expect(e1.text == "macOS hasn't allowed Talos to see the screen yet. On the Mac: Talos → Permissions → Grant. Nothing is stuck.")
    let noAX = ScreenProtocol(service: Fx.core(permissions: FakePermissions(ax: false)), allowList: allow, signing: FakeSigning())
    let e2 = errorOf(try await answer(noAX, #"{"op":"type","text":"x"}"#))
    #expect(e2.code == "accessibility_not_granted")
    #expect(e2.text == "macOS hasn't allowed Talos to control the screen yet. On the Mac: Talos → Permissions → Grant. Nothing is stuck.")
    let front = FakeApps(front: Fx.secret)
    let notAllowed = ScreenProtocol(service: Fx.core(apps: front), allowList: allow, signing: FakeSigning())
    let e3 = errorOf(try await answer(notAllowed, #"{"op":"key","keys":"return"}"#))
    #expect(e3.code == "app_not_allowed" && e3.app == "com.example.secret")
    #expect(e3.text == "com.example.secret isn't on this Mac's allowed list yet.")
    let cap = FakeCapture(Fx.content(), colours: Fx.colours)
    cap.listError = Boom(text: "the stream service is not available")
    let noFilter = ScreenProtocol(service: Fx.core(capture: cap), allowList: allow, signing: FakeSigning())
    let e4 = errorOf(try await answer(noFilter, #"{"op":"shot"}"#))
    #expect(e4.code == "filter_unavailable")
    #expect(
      e4.text == "Talos could not limit the screenshot to the apps you allowed (the stream service is not available), so it took no screenshot.")
    #expect(cap.plans.isEmpty)
  }

  @Test func theDefaultListAllowsNothing() async throws {
    let p = ScreenProtocol(service: Fx.core(), allowList: EmptyScreenAllowList(), signing: FakeSigning())
    #expect(errorOf(try await answer(p, #"{"op":"type","text":"x"}"#)).code == "app_not_allowed")
    let shot = try await answer(p, #"{"op":"shot"}"#)
    #expect(shot["shown_apps"] as? [String] == [] && shot["hidden_windows"] as? Int == 2)
    #expect(errorOf(try await answer(p, #"{"op":"open_app","bundle_id":"com.example.notes"}"#)).code == "app_not_allowed")
  }

  @Test func badRequestsAreTypedAndReachNothing() async throws {
    let f = FakeScreenService()
    let p = ScreenProtocol(service: f, allowList: allow, signing: FakeSigning())
    let cases: [(String, String)] = [
      ("not json", "bad_json"), ("[1,2]", "bad_json"), (#"{"op":"dance"}"#, "unknown_op"), (#"{"id":"q"}"#, "unknown_op"),
      (#"{"v":2,"op":"shot"}"#, "unsupported_version"), (#"{"op":"click","x":"1","y":2}"#, "bad_request"),
      (#"{"op":"click","x":true,"y":2}"#, "bad_request"), (#"{"op":"click","x":1}"#, "bad_request"),
      (#"{"op":"click","x":1,"y":2,"button":"thumb"}"#, "bad_request"), (#"{"op":"click","x":1,"y":2,"count":1.5}"#, "bad_request"),
      (#"{"op":"type"}"#, "bad_request"), (#"{"op":"key","keys":5}"#, "bad_request"), (#"{"op":"open_app"}"#, "bad_request"),
      (#"{"op":"shot","area":{"kind":"moon"}}"#, "bad_request"), (#"{"op":"shot","area":{"kind":"window"}}"#, "bad_request"),
      (#"{"op":"shot","area":"full"}"#, "bad_request"),
    ]
    for (line, code) in cases {
      let o = try await answer(p, line)
      #expect(o["ok"] as? Bool == false && errorOf(o).code == code, "\(line) → \(o)")
      #expect(!(errorOf(o).text ?? "").isEmpty)
    }
    #expect(f.calls.isEmpty)
    // unknown fields are ignored; the id comes back, cut to 100 characters
    let long = String(repeating: "i", count: 300)
    let o = try await answer(p, #"{"op":"apps","future":{"x":1},"id":"\#(long)"}"#)
    #expect(o["ok"] as? Bool == true && (o["id"] as? String)?.count == 100)
  }
}

/// A test socket under /tmp (socket paths are limited to 103 bytes; TMPDIR can be long).
struct SocketDir {
  let root: String
  var home: String { root + "/home" }
  var path: String { ScreenSocket.path(talosHome: home) }
  init() throws {
    root = "/tmp/tss-" + String(UUID().uuidString.prefix(8))
    try FileManager.default.createDirectory(atPath: root + "/home", withIntermediateDirectories: true)
  }
  func cleanup() { try? FileManager.default.removeItem(atPath: root) }
}

/// Connects, sends `data`, and reads one line back (or what came before the close).
func roundTrip(_ path: String, _ data: Data, timeout: Int = 10) -> String? {
  let fd = socket(AF_UNIX, SOCK_STREAM, 0)
  guard fd >= 0 else { return nil }
  defer { close(fd) }
  var on: Int32 = 1
  setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
  var tv = timeval(tv_sec: timeout, tv_usec: 0)
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
  var addr = ScreenSocket.address(path)
  let c = withUnsafePointer(to: &addr) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
  }
  guard c == 0 else { return nil }
  _ = data.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
  var out = Data()
  var buf = [UInt8](repeating: 0, count: 65536)
  while !out.contains(0x0A) {
    let n = buf.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
    if n <= 0 { break }
    out.append(contentsOf: buf[0..<n])
  }
  return String(decoding: out, as: UTF8.self)
}

func lineJSON(_ s: String?) -> [String: Any]? {
  guard let s, let first = s.split(separator: "\n").first else { return nil }
  return (try? JSONSerialization.jsonObject(with: Data(first.utf8))) as? [String: Any]
}

@Suite("Screen socket", .serialized)
struct ScreenSocketTests {
  @Test func answersThisUserOnAPrivateSocket() throws {
    let d = try SocketDir()
    defer { d.cleanup() }
    let s = ScreenSocket(path: d.path, proto: ScreenProtocol(service: FakeScreenService(), allowList: EmptyScreenAllowList(), signing: FakeSigning()))
    try s.start()
    defer { s.stop() }
    var st = stat()
    #expect(lstat(d.path, &st) == 0 && (st.st_mode & S_IFMT) == S_IFSOCK && (st.st_mode & 0o777) == 0o600)
    #expect(lstat(d.home + "/run", &st) == 0 && (st.st_mode & 0o777) == 0o700)
    let o = lineJSON(roundTrip(d.path, Data(#"{"v":1,"id":"z","op":"apps"}"#.utf8) + Data([0x0A])))
    #expect(o?["ok"] as? Bool == true && o?["id"] as? String == "z")
  }

  @Test func aPeerOfAnotherUserIsRefusedAndReachesNothing() throws {
    let d = try SocketDir()
    defer { d.cleanup() }
    let f = FakeScreenService()
    // getpeereid gives this user's uid; the server is told to expect another, as a peer of another user would look
    let s = ScreenSocket(path: d.path, proto: ScreenProtocol(service: f, allowList: EmptyScreenAllowList(), signing: FakeSigning()), ownUID: getuid() + 1)
    try s.start()
    defer { s.stop() }
    let o = lineJSON(roundTrip(d.path, Data(#"{"op":"type","text":"x"}"#.utf8) + Data([0x0A])))
    #expect(errorOf(o ?? [:]).code == "peer_refused")
    #expect(f.calls.isEmpty)
  }

  @Test func anOversizedRequestIsRefusedAndTheConnectionClosed() throws {
    let d = try SocketDir()
    defer { d.cleanup() }
    let f = FakeScreenService()
    let s = ScreenSocket(path: d.path, proto: ScreenProtocol(service: f, allowList: EmptyScreenAllowList(), signing: FakeSigning()))
    try s.start()
    defer { s.stop() }
    let big = #"{"op":"type","text":""# + String(repeating: "x", count: ScreenProtocol.maxRequestBytes) + "\"}\n"
    let o = lineJSON(roundTrip(d.path, Data(big.utf8)))
    #expect(errorOf(o ?? [:]).code == "request_too_large")
    #expect(f.calls.isEmpty)
    // one just under the limit is read whole
    let fits = #"{"op":"key","keys":"a","pad":""# + String(repeating: "p", count: ScreenProtocol.maxRequestBytes - 100) + "\"}\n"
    #expect(lineJSON(roundTrip(d.path, Data(fits.utf8)))?["ok"] as? Bool == true)
  }

  @Test func severalRequestsOnOneConnectionAreAnsweredInOrder() throws {
    let d = try SocketDir()
    defer { d.cleanup() }
    let s = ScreenSocket(path: d.path, proto: ScreenProtocol(service: FakeScreenService(), allowList: EmptyScreenAllowList(), signing: FakeSigning()))
    try s.start()
    defer { s.stop() }
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    defer { close(fd) }
    var addr = ScreenSocket.address(d.path)
    _ = withUnsafePointer(to: &addr) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    let req = #"{"id":"1","op":"apps"}"# + "\n" + #"{"id":"2","op":"nope"}"# + "\n"
    _ = Data(req.utf8).withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
    var out = Data()
    var buf = [UInt8](repeating: 0, count: 4096)
    while out.filter({ $0 == 0x0A }).count < 2 {
      let n = buf.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
      if n <= 0 { break }
      out.append(contentsOf: buf[0..<n])
    }
    let lines = String(decoding: out, as: UTF8.self).split(separator: "\n").compactMap { lineJSON(String($0)) }
    #expect(lines.map { $0["id"] as? String } == ["1", "2"])
    #expect(lines.map { $0["ok"] as? Bool } == [true, false])
  }

  /// Two sessions typing at once: one finishes before the other starts.
  @Test func requestsFromTwoConnectionsNeverOverlap() async throws {
    let d = try SocketDir()
    defer { d.cleanup() }
    let f = FakeScreenService()
    f.inputDelay = 0.3
    let s = ScreenSocket(path: d.path, proto: ScreenProtocol(service: f, allowList: EmptyScreenAllowList(), signing: FakeSigning()))
    try s.start()
    defer { s.stop() }
    let path = d.path
    async let a = Task.detached { roundTrip(path, Data(#"{"op":"type","text":"aaa"}"#.utf8 + [0x0A])) }.value
    async let b = Task.detached { roundTrip(path, Data(#"{"op":"type","text":"bbb"}"#.utf8 + [0x0A])) }.value
    let (ra, rb) = await (a, b)
    #expect(lineJSON(ra)?["ok"] as? Bool == true && lineJSON(rb)?["ok"] as? Bool == true)
    let spans = f.spans.sorted { $0.0 < $1.0 }
    #expect(spans.count == 2)
    if spans.count == 2 { #expect(spans[1].0 >= spans[0].1, "\(spans)") }
  }

  @Test func aStaleSocketIsReplacedALiveOneAndAFileAreNot() throws {
    let d = try SocketDir()
    defer { d.cleanup() }
    let proto = ScreenProtocol(service: FakeScreenService(), allowList: EmptyScreenAllowList(), signing: FakeSigning())
    let first = ScreenSocket(path: d.path, proto: proto)
    try first.start()
    #expect(throws: ScreenSocket.StartError.inUse(d.path)) { try ScreenSocket(path: d.path, proto: proto).start() }
    // a socket file left by a crash: nothing listens on it
    first.stop()
    let stale = socket(AF_UNIX, SOCK_STREAM, 0)
    var addr = ScreenSocket.address(d.path)
    _ = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(stale, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
    close(stale)
    let second = ScreenSocket(path: d.path, proto: proto)
    try second.start()
    #expect(lineJSON(roundTrip(d.path, Data(#"{"op":"apps"}"#.utf8 + [0x0A])))?["ok"] as? Bool == true)
    second.stop()
    #expect(!FileManager.default.fileExists(atPath: d.path))
    FileManager.default.createFile(atPath: d.path, contents: Data("keep".utf8))
    #expect(throws: ScreenSocket.StartError.notASocket(d.path)) { try ScreenSocket(path: d.path, proto: proto).start() }
    #expect(FileManager.default.contents(atPath: d.path) == Data("keep".utf8))
  }

  @Test func stopLeavesAnotherServersSocketAlone() throws {
    let d = try SocketDir()
    defer { d.cleanup() }
    let proto = ScreenProtocol(service: FakeScreenService(), allowList: EmptyScreenAllowList(), signing: FakeSigning())
    let old = ScreenSocket(path: d.path, proto: proto)
    try old.start()
    // another app took the path over (unlinked and bound its own)
    unlink(d.path)
    let other = ScreenSocket(path: d.path, proto: proto)
    try other.start()
    defer { other.stop() }
    old.stop()
    #expect(lineJSON(roundTrip(d.path, Data(#"{"op":"apps"}"#.utf8 + [0x0A])))?["ok"] as? Bool == true)
  }

  @Test func aFolderOfAnotherKindOrTooLongAPathIsRefused() throws {
    let d = try SocketDir()
    defer { d.cleanup() }
    let proto = ScreenProtocol(service: FakeScreenService(), allowList: EmptyScreenAllowList(), signing: FakeSigning())
    try FileManager.default.createSymbolicLink(atPath: d.home + "/run", withDestinationPath: d.root)
    #expect(throws: ScreenSocket.StartError.folder(d.home + "/run")) { try ScreenSocket(path: d.path, proto: proto).start() }
    let long = "/tmp/" + String(repeating: "x", count: 120) + "/screen.sock"
    #expect(throws: ScreenSocket.StartError.pathTooLong(long)) { try ScreenSocket(path: long, proto: proto).start() }
  }
}

/// R1-6: one request at a time, and a request that runs past its time keeps the next one out until it really ends.
@Suite("Screen socket: the queue", .serialized)
struct ScreenSocketQueueTests {
  func start(_ f: FakeScreenService, request: Double, queue: Double) throws -> (SocketDir, ScreenSocket) {
    let d = try SocketDir()
    let s = ScreenSocket(
      path: d.path, proto: ScreenProtocol(service: f, allowList: EmptyScreenAllowList(), signing: FakeSigning()),
      requestSeconds: request, queueSeconds: queue)
    try s.start()
    return (d, s)
  }

  @Test func aTimedOutRequestStillHoldsTheScreenUntilItEnds() async throws {
    let f = FakeScreenService()
    f.inputDelay = 1.0
    let (d, s) = try start(f, request: 0.3, queue: 5)
    defer { s.stop(); d.cleanup() }
    let path = d.path
    async let a = Task.detached { roundTrip(path, Data(#"{"op":"type","text":"aaa"}"#.utf8 + [0x0A])) }.value
    try await Task.sleep(nanoseconds: 450_000_000)
    async let b = Task.detached { () -> (String?, Double) in
      let r = roundTrip(path, Data(#"{"op":"apps"}"#.utf8 + [0x0A]))
      return (r, Date().timeIntervalSince1970)
    }.value
    let (ra, (rb, bAt)) = await (a, b)
    #expect(errorOf(lineJSON(ra) ?? [:]).code == "timed_out")
    #expect(lineJSON(rb)?["ok"] as? Bool == true)
    let typed = try #require(f.spans.first)
    #expect(bAt >= typed.1, "the second ran while the first still typed")
  }

  @Test func aRequestThatWaitsTooLongIsAnsweredBusyAndNeverRuns() async throws {
    let f = FakeScreenService()
    f.inputDelay = 1.0
    let (d, s) = try start(f, request: 5, queue: 0.2)
    defer { s.stop(); d.cleanup() }
    let path = d.path
    async let a = Task.detached { roundTrip(path, Data(#"{"op":"type","text":"aaa"}"#.utf8 + [0x0A])) }.value
    try await Task.sleep(nanoseconds: 150_000_000)
    let rb = await Task.detached { roundTrip(path, Data(#"{"id":"b","op":"type","text":"bbb"}"#.utf8 + [0x0A])) }.value
    let e = errorOf(lineJSON(rb) ?? [:])
    #expect(e.code == "busy")
    #expect(e.text == "The screen helper is still busy with another request, so nothing was done. Try again in a moment.")
    _ = await a
    #expect(f.calls.count == 1, "the busy request never ran: \(f.calls)")
  }

  @Test func aQueuedLineWhoseClientLeftIsDropped() async throws {
    let f = FakeScreenService()
    f.inputDelay = 0.6
    let (d, s) = try start(f, request: 5, queue: 5)
    defer { s.stop(); d.cleanup() }
    let path = d.path
    async let a = Task.detached { roundTrip(path, Data(#"{"op":"type","text":"aaa"}"#.utf8 + [0x0A])) }.value
    try await Task.sleep(nanoseconds: 150_000_000)
    // a client that sends and hangs up while the first still runs
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    var addr = ScreenSocket.address(path)
    _ = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
    _ = Data(#"{"op":"type","text":"gone"}"#.utf8 + [0x0A]).withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
    close(fd)
    _ = await a
    try await Task.sleep(nanoseconds: 300_000_000)
    #expect(!f.calls.contains(.input(.type("gone"), [])), "a line whose client left must not run: \(f.calls)")
  }
}
