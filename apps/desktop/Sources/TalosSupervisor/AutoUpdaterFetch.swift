import CryptoKit
import Darwin
import Foundation
import TalosDesktopCore

/// A GET with a byte cap and a time limit; redirects followed only to https (or, for a local test feed, nowhere else).
public enum CappedFetch {
  final class Box: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    let max: Int
    let out: FileHandle?
    var data = Data()
    var count = 0
    var failed = false
    let done = DispatchSemaphore(value: 0)
    init(max: Int, out: FileHandle?) {
      self.max = max
      self.out = out
    }
    func urlSession(
      _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
      completionHandler: @escaping (URLRequest?) -> Void
    ) {
      if request.url?.scheme?.lowercased() == "https" { completionHandler(request) } else {
        failed = true
        completionHandler(nil)
      }
    }
    func urlSession(
      _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
      completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
      if let h = response as? HTTPURLResponse, h.statusCode != 200 { failed = true }
      if response.expectedContentLength > Int64(max) { failed = true }
      completionHandler(failed ? .cancel : .allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive d: Data) {
      count += d.count
      guard count <= max, !failed else {
        failed = true
        dataTask.cancel()
        return
      }
      if let out { out.write(d) } else { data.append(d) }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
      if error != nil { failed = true }
      done.signal()
    }
  }

  static func get(_ url: URL, max: Int, timeout: Double, out: FileHandle?) -> Box? {
    let box = Box(max: max, out: out)
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = min(timeout, 60)
    config.timeoutIntervalForResource = timeout
    config.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    let session = URLSession(configuration: config, delegate: box, delegateQueue: nil)
    defer { session.invalidateAndCancel() }
    session.dataTask(with: url).resume()
    // the resource limit ends the task; this wait is only a floor under it
    guard box.done.wait(timeout: .now() + timeout + 30) == .success, !box.failed else { return nil }
    return box
  }

  public static func data(_ url: URL, _ max: Int, _ timeout: Double) -> Data? {
    get(url, max: max, timeout: timeout, out: nil)?.data
  }

  public static func file(_ url: URL, _ path: String, _ max: Int, _ timeout: Double) -> Bool {
    guard FileManager.default.createFile(atPath: path, contents: nil, attributes: [.posixPermissions: 0o600]),
      let h = FileHandle(forWritingAtPath: path)
    else { return false }
    let ok = get(url, max: max, timeout: timeout, out: h) != nil
    try? h.close()
    if !ok { try? FileManager.default.removeItem(atPath: path) }
    return ok
  }
}

/// The live process table for `BackgroundWork`: every process's pid, parent and name (`KERN_PROC_ALL`), and the argv of the few
/// whose name may stand for claude (`BackgroundWork.wantsArgv`: node, bun, a native install's version name).
public enum ProcTable {
  public static func live() -> [BackgroundWork.Proc]? {
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0]
    var size = 0
    guard sysctl(&mib, 4, nil, &size, nil, 0) == 0, size > 0 else { return nil }
    size += size / 4  // room for processes started in between
    var procs = [kinfo_proc](repeating: kinfo_proc(), count: size / MemoryLayout<kinfo_proc>.stride)
    guard sysctl(&mib, 4, &procs, &size, nil, 0) == 0 else { return nil }
    let n = size / MemoryLayout<kinfo_proc>.stride
    return procs.prefix(n).map { p in
      var c = p.kp_proc.p_comm
      let name = withUnsafeBytes(of: &c) { raw in
        String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
      }
      let pid = p.kp_proc.p_pid
      let argv = BackgroundWork.wantsArgv(name) ? ProcessInspect.snapshot(pid)?.argv : nil
      return BackgroundWork.Proc(pid: pid, ppid: p.kp_eproc.e_ppid, name: name, argv: argv)
    }
  }

  /// The background work under these pane processes, as one short reason ("background work: zsh (pid 412), ..."); nil when there is
  /// none. A table that cannot be read is a reason too: unknown is not quiet.
  public static func reason(panes: [Int32], table: [BackgroundWork.Proc]? = live()) -> String? {
    guard !panes.isEmpty else { return nil }
    guard let table else { return "the process list could not be read" }
    let found = BackgroundWork.offenders(table, panes: panes)
    guard !found.isEmpty else { return nil }
    return "background work: " + found.prefix(5).map { "\($0.name) (pid \($0.pid))" }.joined(separator: ", ")
  }
}

/// The updater's file helpers: a file's size and sha256, and the detached swap.
extension AutoUpdater {
  static func fileSize(_ path: String) -> Int? {
    (try? FileManager.default.attributesOfItem(atPath: path)[.size] as? NSNumber)?.intValue
  }

  /// Lowercase hex sha256 of a file, read in pieces.
  static func sha256(_ path: String) -> String? {
    guard let h = FileHandle(forReadingAtPath: path) else { return nil }
    defer { try? h.close() }
    var hasher = SHA256()
    while true {
      // nil or empty: the end of the file; a read that throws is no hash
      let chunk: Data?
      do { chunk = try h.read(upToCount: 1 << 20) } catch { return nil }
      guard let chunk, !chunk.isEmpty else { break }
      hasher.update(data: chunk)
    }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
  }

  /// posix_spawn in a new session (it outlives this app and gets no signal meant for its group), stdin from /dev/null, output to `log`.
  public static func spawnDetached(_ argv: [String], _ env: [String: String], _ log: String) -> Int32? {
    var attr: posix_spawnattr_t?
    posix_spawnattr_init(&attr)
    defer { posix_spawnattr_destroy(&attr) }
    posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETSID | POSIX_SPAWN_CLOEXEC_DEFAULT))
    var fa: posix_spawn_file_actions_t?
    posix_spawn_file_actions_init(&fa)
    defer { posix_spawn_file_actions_destroy(&fa) }
    posix_spawn_file_actions_addopen(&fa, 0, "/dev/null", O_RDONLY, 0)
    posix_spawn_file_actions_addopen(&fa, 1, log, O_WRONLY | O_CREAT | O_APPEND, 0o600)
    posix_spawn_file_actions_adddup2(&fa, 1, 2)
    let cArgs = argv.map { strdup($0) } + [nil]
    let cEnv = env.map { strdup("\($0.key)=\($0.value)") } + [nil]
    defer { (cArgs + cEnv).forEach { free($0) } }
    var pid: pid_t = 0
    let rc = posix_spawn(&pid, argv[0], &fa, &attr, cArgs, cEnv)
    return rc == 0 ? pid : nil
  }
}
