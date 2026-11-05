import AppKit
import Foundation
import SwiftTerm
import Testing
import TalosDesktopCore
@testable import TalosDesktop

/// A tiny real HTTP server on 127.0.0.1, used as the relay: RelayOrigin allows http on loopback, so redirects, CSP headers
/// and real origins are exercised end to end instead of being faked with `loadHTMLString`.
final class FakeRelay: @unchecked Sendable {
  struct Request: Sendable {
    var method: String
    var path: String
  }
  struct Response: Sendable {
    var status = 200
    var headers: [String: String] = [:]
    var body = ""
    /// Content-Length to announce when it differs from the body (a download the server cuts short).
    var declaredLength: Int?
  }
  typealias Handler = @Sendable (Request) -> Response?

  private let lock = NSLock()
  private var fd: Int32 = -1
  private var _log: [Request] = []
  private let handler: Handler
  private(set) var port: UInt16 = 0

  init(port wanted: UInt16 = 0, handler: @escaping Handler) throws {
    self.handler = handler
    let s = socket(AF_INET, SOCK_STREAM, 0)
    guard s >= 0 else { throw POSIXError(.EIO) }
    var yes: Int32 = 1
    setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
    var a = sockaddr_in()
    a.sin_family = sa_family_t(AF_INET)
    a.sin_addr.s_addr = inet_addr("127.0.0.1")
    a.sin_port = wanted.bigEndian
    let bound = withUnsafePointer(to: &a) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(s, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }
    guard bound == 0, listen(s, 32) == 0 else {
      close(s)
      throw POSIXError(.EADDRINUSE)
    }
    var got = sockaddr_in()
    var len = socklen_t(MemoryLayout<sockaddr_in>.size)
    _ = withUnsafeMutablePointer(to: &got) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(s, $0, &len) }
    }
    port = UInt16(bigEndian: got.sin_port)
    fd = s
    Thread.detachNewThread { [self] in acceptLoop(s) }
  }

  var origin: String { "http://127.0.0.1:\(port)" }
  var relay: RelayOrigin { RelayOrigin(origin)! }
  var log: [Request] { lock.withLock { _log } }
  func saw(_ path: String) -> Bool { log.contains { $0.path == path } }
  func saw(method: String, _ path: String) -> Bool { log.contains { $0.method == method && $0.path == path } }

  func stop() {
    lock.withLock {
      if fd >= 0 {
        shutdown(fd, SHUT_RDWR)
        close(fd)
        fd = -1
      }
    }
  }

  private func acceptLoop(_ s: Int32) {
    while true {
      let c = accept(s, nil, nil)
      if c < 0 { return }
      Thread.detachNewThread { [self] in serve(c) }
    }
  }

  private func serve(_ c: Int32) {
    defer { close(c) }
    var data = Data()
    var buf = [UInt8](repeating: 0, count: 8192)
    while data.range(of: Data("\r\n\r\n".utf8)) == nil {
      let n = read(c, &buf, buf.count)
      if n <= 0 { return }
      data.append(contentsOf: buf[0..<n])
    }
    let head = String(decoding: data, as: UTF8.self)
    let first = head.split(separator: "\r\n").first.map(String.init) ?? ""
    let parts = first.split(separator: " ").map(String.init)
    guard parts.count >= 2 else { return }
    let req = Request(method: parts[0], path: parts[1])
    lock.withLock { _log.append(req) }
    let r = handler(req) ?? Response(status: 404, body: "nope")
    var out = "HTTP/1.1 \(r.status) X\r\nConnection: close\r\nContent-Length: \(r.declaredLength ?? r.body.utf8.count)\r\n"
    var headers = r.headers
    if headers["Content-Type"] == nil { headers["Content-Type"] = "text/html; charset=utf-8" }
    for (k, v) in headers { out += "\(k): \(v)\r\n" }
    out += "\r\n" + r.body
    let bytes = Array(out.utf8)
    _ = bytes.withUnsafeBufferPointer { write(c, $0.baseAddress, $0.count) }
  }
}

/// Lets the main actor go (WebKit's callbacks arrive on the main queue, which a nested run loop would not drain) and
/// gives the main run loop a slice in between (AppKit timers fire there; under `swift test` nothing else spins it).
@MainActor func pump(_ seconds: Double = 1.2) async {
  let end = Date().addingTimeInterval(seconds)
  while Date() < end {
    try? await Task.sleep(nanoseconds: 15_000_000)
    spinOnce()
  }
}

@MainActor private func spinOnce() { _ = CFRunLoopRunInMode(.defaultMode, 0.005, true) }

@MainActor func pumpUntil(_ seconds: Double, _ ok: @MainActor () -> Bool) async -> Bool {
  let end = Date().addingTimeInterval(seconds)
  while Date() < end {
    if ok() { return true }
    await pump(0.03)
  }
  return ok()
}

/// NSAlert.runModal would block a test forever: this answers the first button and records what the alert said.
enum AlertSpy {
  nonisolated(unsafe) static var seen: [String] = []
  nonisolated(unsafe) private static var installed = false
  @MainActor static func install() {
    seen = []
    if installed { return }
    installed = true
    let m = class_getInstanceMethod(NSAlert.self, #selector(NSAlert.runModal))!
    let block: @convention(block) (NSAlert) -> NSApplication.ModalResponse = { a in
      AlertSpy.seen.append(a.messageText + " | " + a.informativeText)
      return .alertFirstButtonReturn
    }
    method_setImplementation(m, imp_implementationWithBlock(block))
  }
}

/// The owner's live session runs on this Mac: a test process must never be able to take the keyboard from it.
@MainActor func cannotTakeTheKeyboard() {
  _ = NSApplication.shared
  NSApp.setActivationPolicy(.prohibited)
}

/// Temp folder + `HOME` pointing at it, so the login-shell read (`zsh -lic`) never runs the owner's rc files.
@MainActor func withScratchHome<T>(_ body: @MainActor (String) async throws -> T) async rethrows -> T {
  let base = (NSTemporaryDirectory() as NSString).appendingPathComponent("talos-rv-\(UUID().uuidString.prefix(8))")
  try? FileManager.default.createDirectory(atPath: base, withIntermediateDirectories: true)
  let old = getenv("HOME").map { String(cString: $0) }
  setenv("HOME", base, 1)
  defer {
    if let old { setenv("HOME", old, 1) }
    try? FileManager.default.removeItem(atPath: base)
  }
  return try await body(base)
}

func writeScript(_ path: String, _ text: String) {
  try? text.write(toFile: path, atomically: true, encoding: .utf8)
  chmod(path, 0o755)
}

/// Every terminal view the owner could see or type into, tabs included.
@MainActor func terminalViews(in view: NSView) -> [LocalProcessTerminalView] {
  var out: [LocalProcessTerminalView] = []
  if let t = view as? LocalProcessTerminalView { out.append(t) }
  if let tabs = view as? NSTabView {
    for i in tabs.tabViewItems { if let v = i.view { out += terminalViews(in: v) } }
  }
  for s in view.subviews { out += terminalViews(in: s) }
  return out
}

@MainActor func allTerminalViews() -> [LocalProcessTerminalView] {
  // Each view once: a selected tab's content is reachable both through the tab item and through the tab view's subviews,
  // and a shown window made the sign-in pane count twice (helper fixed in D2; the assertions are unchanged).
  var seen = Set<ObjectIdentifier>()
  return NSApp.windows.flatMap { w in w.contentView.map { terminalViews(in: $0) } ?? [] }.filter { seen.insert(ObjectIdentifier($0)).inserted }
}

/// The GUI review suites share process-wide singletons (`PairingController.shared`, `TerminalWindowController.shared`), so
/// they must not run beside each other: Swift Testing runs top-level suites in parallel, and nested suites of a serialized
/// parent run one at a time. Review suites that touch those singletons nest here.
@Suite("GUI singletons", .serialized, .guiExclusive)
struct GuiSerial {}
