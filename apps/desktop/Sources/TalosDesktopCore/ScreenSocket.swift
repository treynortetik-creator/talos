import Foundation

/// The screen helper's Unix socket inside Talos.app: `$TALOS_APP_HOME/run/screen.sock`, beside the bridge's `hub.sock`, in the
/// same 0700 folder, the socket itself 0600. Only a peer running as this user is answered (`getpeereid`); any other gets one
/// `peer_refused` line and the connection closes. One request per line, at most `ScreenProtocol.maxRequestBytes`; a longer line
/// is answered `request_too_large` and the connection closes. Requests run one at a time across every connection, so two
/// sessions' typing never interleaves.
///
/// The socket answers in the app's process, so macOS asks about (and charges) Talos.app for every capture and event.
public final class ScreenSocket: @unchecked Sendable {
  public enum StartError: Error, Equatable, CustomStringConvertible {
    case pathTooLong(String)
    case folder(String)
    case notASocket(String)
    case inUse(String)
    case posix(String, Int32)
    public var description: String {
      switch self {
      case .pathTooLong(let p): return "the socket path is too long for macOS: \(p)"
      case .folder(let p): return "\(p) is not a private folder of this user"
      case .notASocket(let p): return "\(p) is there and is not a socket; left alone"
      case .inUse(let p): return "another Talos app already answers on \(p)"
      case .posix(let what, let e): return "\(what) failed: \(String(cString: strerror(e)))"
      }
    }
  }

  public static func path(talosHome: String) -> String { talosHome + "/run/screen.sock" }

  /// Seconds a connection may sit with no complete request before it is closed.
  public static let idleSeconds = 30
  /// Seconds one request may run before the answer is `timed_out` (the bridge gives up at 15 s).
  public static let requestSeconds = 20.0
  /// Seconds a request may wait for the one before it; past that it is answered `busy` and never runs.
  public static let queueSeconds = 10.0
  public static let busyText = "The screen helper is still busy with another request, so nothing was done. Try again in a moment."
  /// Connections open at once; one more is closed at once.
  public static let maxConnections = 8

  let proto: ScreenProtocol
  /// The uid a peer must have: this process's own, except in a test of the refusal.
  let ownUID: uid_t
  public let path: String
  private let lock = NSLock()
  /// The screen is used by one request at a time: `busy` from the start of a request until its work has really ended (a request
  /// answered `timed_out` keeps it until then), so no two ever overlap.
  private let gate = NSCondition()
  private var busy = false
  let requestLimit: Double
  let queueLimit: Double
  private var listenFD: Int32 = -1
  private var boundInode: ino_t = 0
  private var open = 0
  private var stopped = false

  public init(
    path: String, proto: ScreenProtocol, ownUID: uid_t = getuid(), requestSeconds: Double = ScreenSocket.requestSeconds,
    queueSeconds: Double = ScreenSocket.queueSeconds
  ) {
    self.path = path
    self.proto = proto
    self.ownUID = ownUID
    self.requestLimit = requestSeconds
    self.queueLimit = queueSeconds
  }

  deinit { stop() }

  /// Binds and starts answering. A stale socket of this user's with nothing listening is replaced; a live one is not.
  public func start() throws(StartError) {
    let dir = (path as NSString).deletingLastPathComponent
    guard path.utf8.count < 104 else { throw .pathTooLong(path) }
    mkdir(dir, 0o700)
    var st = stat()
    guard lstat(dir, &st) == 0, (st.st_mode & S_IFMT) == S_IFDIR, st.st_uid == getuid() else { throw .folder(dir) }
    chmod(dir, 0o700)
    if lstat(path, &st) == 0 {
      guard (st.st_mode & S_IFMT) == S_IFSOCK else { throw .notASocket(path) }
      if Self.answers(path) { throw .inUse(path) }
      unlink(path)
    }
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw .posix("socket", errno) }
    var on: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
    var addr = Self.address(path)
    let bound = withUnsafePointer(to: &addr) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    guard bound == 0 else {
      let e = errno
      close(fd)
      throw .posix("bind", e)
    }
    chmod(path, 0o600)
    guard listen(fd, 16) == 0 else {
      let e = errno
      close(fd)
      unlink(path)
      throw .posix("listen", e)
    }
    lstat(path, &st)
    lock.withLock {
      listenFD = fd
      boundInode = st.st_ino
      stopped = false
    }
    let t = Thread { [weak self] in self?.acceptLoop(fd) }
    t.name = "talos.screen-socket"
    t.start()
  }

  /// Stops answering and removes the socket file, if it is still the one this server made.
  public func stop() {
    let (fd, ino) = lock.withLock { () -> (Int32, ino_t) in
      let r = (listenFD, boundInode)
      listenFD = -1
      stopped = true
      return r
    }
    guard fd >= 0 else { return }
    shutdown(fd, SHUT_RDWR)
    close(fd)
    var st = stat()
    if lstat(path, &st) == 0, st.st_ino == ino, (st.st_mode & S_IFMT) == S_IFSOCK { unlink(path) }
  }

  public var isRunning: Bool { lock.withLock { listenFD >= 0 } }

  static func address(_ path: String) -> sockaddr_un {
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8)
    withUnsafeMutableBytes(of: &addr.sun_path) { buf in
      for (i, b) in bytes.enumerated() where i < buf.count - 1 { buf[i] = b }
    }
    return addr
  }

  /// Whether something answers a connect on `path` now.
  static func answers(_ path: String) -> Bool {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { return false }
    defer { close(fd) }
    var addr = address(path)
    return withUnsafePointer(to: &addr) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    } == 0
  }

  private func acceptLoop(_ fd: Int32) {
    while true {
      let c = accept(fd, nil, nil)
      if c < 0 {
        if errno == EINTR { continue }
        return  // closed by stop()
      }
      var on: Int32 = 1
      setsockopt(c, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
      let admitted = lock.withLock { () -> Bool in
        guard !stopped, open < Self.maxConnections else { return false }
        open += 1
        return true
      }
      guard admitted else {
        close(c)
        continue
      }
      let t = Thread { [weak self] in
        self?.serve(c)
        close(c)
        self?.lock.withLock { self?.open -= 1 }
      }
      t.name = "talos.screen-socket.client"
      t.start()
    }
  }

  private func serve(_ c: Int32) {
    var uid: uid_t = 0
    var gid: gid_t = 0
    guard getpeereid(c, &uid, &gid) == 0, uid == ownUID else {
      Self.send(c, ScreenProtocol.error(id: nil, code: ScreenProtocol.ServerCode.peerRefused, text: "Only this Mac user's own sessions may use the screen."))
      return
    }
    var tv = timeval(tv_sec: Self.idleSeconds, tv_usec: 0)
    setsockopt(c, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
    var buf = Data()
    var chunk = [UInt8](repeating: 0, count: 16 * 1024)
    while true {
      while let nl = buf.firstIndex(of: 0x0A) {
        let line = buf[buf.startIndex..<nl]
        buf = Data(buf[buf.index(after: nl)...])
        // nil: the client left while the line waited; nothing ran and nobody is there to answer
        guard let answer = run(Data(line), client: c), Self.send(c, answer) else { return }
      }
      if buf.count >= ScreenProtocol.maxRequestBytes {
        Self.send(c, ScreenProtocol.error(
          id: nil, code: ScreenProtocol.ServerCode.requestTooLarge,
          text: "The request is over \(ScreenProtocol.maxRequestBytes) bytes; nothing was done."))
        return
      }
      let n = chunk.withUnsafeMutableBytes { read(c, $0.baseAddress, min($0.count, ScreenProtocol.maxRequestBytes - buf.count)) }
      if n <= 0 { return }  // closed, an error, or idle too long
      buf.append(contentsOf: chunk[0..<n])
    }
  }

  /// One request, after any other request has really ended. Waits at most `queueLimit` for its turn (then `busy`, and it never
  /// runs); a line whose client hung up while it waited is dropped. Past `requestLimit` the client is answered `timed_out` and the
  /// work is cancelled (typing stops at its next piece), but the screen stays taken until that work has ended.
  private func run(_ line: Data, client c: Int32) -> Data? {
    let id = (((try? JSONSerialization.jsonObject(with: line)) as? [String: Any])?["id"] as? String).map { String($0.prefix(100)) }
    gate.lock()
    let deadline = Date().addingTimeInterval(queueLimit)
    while busy {
      if !gate.wait(until: deadline), busy {
        gate.unlock()
        return ScreenProtocol.error(id: id, code: ScreenProtocol.ServerCode.busy, text: Self.busyText)
      }
    }
    guard Self.stillThere(c) else {
      gate.unlock()
      return nil
    }
    busy = true
    gate.unlock()
    let box = AnswerBox()
    let done = DispatchSemaphore(value: 0)
    let proto = self.proto
    let task = Task.detached { [weak self] in
      box.set(await proto.answer(line))
      done.signal()
      self?.release()
    }
    if done.wait(timeout: .now() + requestLimit) == .timedOut {
      task.cancel()
      return ScreenProtocol.error(
        id: id, code: ScreenProtocol.ServerCode.timedOut,
        text: "The screen helper took longer than \(Int(requestLimit.rounded())) s; it may still finish. Take a screenshot to check.")
    }
    return box.get() ?? ScreenProtocol.error(id: nil, code: ScreenProtocol.ServerCode.badJSON, text: "No answer was made.")
  }

  private func release() {
    gate.lock()
    busy = false
    gate.broadcast()
    gate.unlock()
  }

  /// Whether the client is still connected: a peek that finds the end of the stream means it hung up.
  static func stillThere(_ c: Int32) -> Bool {
    var b: UInt8 = 0
    let n = recv(c, &b, 1, MSG_PEEK | MSG_DONTWAIT)
    return n > 0 || (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK))
  }

  @discardableResult
  static func send(_ c: Int32, _ data: Data) -> Bool {
    var out = data
    out.append(0x0A)
    return out.withUnsafeBytes { buf in
      var off = 0
      while off < buf.count {
        let n = write(c, buf.baseAddress! + off, buf.count - off)
        if n <= 0 { return false }
        off += n
      }
      return true
    }
  }
}

final class AnswerBox: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Data?
  func set(_ d: Data) { lock.withLock { value = d } }
  func get() -> Data? { lock.withLock { value } }
}
