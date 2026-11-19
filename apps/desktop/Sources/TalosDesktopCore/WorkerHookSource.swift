import Foundation

/// Where a thread session's permission hook comes from on the Mac: the app bundle's own sealed copy
/// (`Contents/Resources/talos-hooks/`, put there read-only by build-app.sh before the bundle is signed). Never the checkout: a thread
/// working in the checkout may edit files there without a prompt, and the hook is the script that answers that thread's prompts.
///
/// Every start asks `verified()`, and gets the script's bytes only when all of this holds:
///  - the script is no link, is really inside the app bundle (every link on the way resolved), a plain file with no write bit for
///    anyone, owned by this account or root, in a folder that is a real folder of this account or root which no other account can
///    write, and the app is not inside the starting thread's folder or the agent folder;
///  - the app bundle's code signature checks out (`seal`: asked once per run of the app, and the answer kept, pass or fail);
///  - the file is the one that was there at that check (device, inode, modification time, size) and holds the same bytes.
/// Each file is opened once (never through a link) and everything is asked of that one open file: what it is, whose it is, and
/// its bytes. So the file that was checked is the file that was read, whatever is done to its name in between, and the bytes
/// handed back are the bytes that were compared: nothing can be swapped in between the check and the copy.
/// The folder's owner may write it (the Linux release's folders have no write bit at all): the bundle is replaced whole when the
/// app is updated, by this account, and a folder its owner cannot write stops that. The owner's write bit is no fence anyway, for
/// the owner can set it; the signature and the bytes kept from the check are what hold.
/// Tests build a folder shaped like a bundle and pass their own `seal`; nothing here reads `Bundle.main`.
extension WorkerHook {
  public static let bundleFolder = "talos-hooks"
  public static let noBundledHook = "this Talos app has no permission hook inside it, so a thread session's permission hook can't be found"

  public final class BundleSource: @unchecked Sendable {
    /// The hook and the helper beside it (nil: the bundle has none), as checked.
    public struct Verified: Equatable, Sendable {
      public var path: String
      public var script: Data
      public var helper: Data?
      /// The thread-state hook's files by name (`WorkerHook.stateFileNames`), when the bundle has every one of them and the helper they
      /// import; nil otherwise (a bundle built before they were added): no thread-state hook for the session.
      public var state: [String: Data]?
    }

    public enum Answer: Equatable, Sendable {
      case ok(Verified)
      case problem(String)
    }

    /// One file as it was when the signature was checked. `changed` is the last status change: it cannot be set back by a program,
    /// so it guards the moment of the check itself; it is not held against later starts (the system adds attributes of its own).
    struct Mark: Equatable {
      var device: UInt64
      var inode: UInt64
      var modified: timespec
      var changed: timespec
      var size: Int64

      func sameFile(_ o: Mark) -> Bool {
        device == o.device && inode == o.inode && size == o.size && modified.tv_sec == o.modified.tv_sec && modified.tv_nsec == o.modified.tv_nsec
      }
      init(_ st: stat) {
        device = UInt64(st.st_dev)
        inode = UInt64(st.st_ino)
        modified = st.st_mtimespec
        changed = st.st_ctimespec
        size = Int64(st.st_size)
      }
      static func == (a: Mark, b: Mark) -> Bool { a.sameFile(b) && a.changed.tv_sec == b.changed.tv_sec && a.changed.tv_nsec == b.changed.tv_nsec }
    }

    private struct Baseline {
      var path: String
      var script: Mark
      var helper: Mark?
      var scriptBytes: Data
      var helperBytes: Data?
      var state: [String: File]?
    }

    public let script: String?
    public let bundlePath: String
    private let seal: @Sendable (String) -> String?
    private let lock = NSLock()
    private var baseline: Baseline?
    private var sealProblem: String?

    /// `script`: the bundled hook's path, nil when the bundle has none. `seal`: why the bundle at this path fails its code signature
    /// check, or nil when it passes.
    public init(script: String?, bundlePath: String, seal: @escaping @Sendable (String) -> String?) {
      self.script = script
      self.bundlePath = bundlePath
      self.seal = seal
    }

    /// The hook to copy, or the exact reason this start is refused. `outside`: folders the app must not be in (the starting
    /// thread's folder, the agent folder), where a thread session edits files without a prompt.
    public func verified(outside: [String] = []) -> Answer {
      lock.lock()
      defer { lock.unlock() }
      guard let script else { return .problem(WorkerHook.noBundledHook) }
      if let why = WorkerHook.scriptProblem(script) { return .problem(why) }
      var link = stat()
      if lstat(script, &link) == 0, link.st_mode & S_IFMT == S_IFLNK { return .problem(Self.isLink(script)) }
      guard let real = Self.real(script), let bundle = Self.real(bundlePath) else { return .problem("the permission hook \(script) is missing or cannot be read") }
      guard real.hasPrefix(bundle + "/") else { return .problem("the permission hook \(script) is not inside the Talos app (\(bundlePath))") }
      for f in outside.filter({ $0.hasPrefix("/") }).compactMap(Self.real) where bundle == f || bundle.hasPrefix(f.hasSuffix("/") ? f : f + "/") {
        return .problem("the Talos app \(bundle) is inside \(f), a folder a thread session works in")
      }
      let folder = (real as NSString).deletingLastPathComponent
      if let why = Self.folderProblem(folder) { return .problem(why) }
      let helper = folder + "/" + WorkerHook.helper
      let files: Loaded
      switch Self.load(script: real, helper: helper) {
      case .failure(let why): return .problem(why.text)
      case .success(let l): files = l
      }
      if let sealProblem { return .problem(sealProblem) }
      guard let base = baseline else {
        if let detail = seal(bundle) {
          let why = "the Talos app's code signature does not check out (\(detail)), so its permission hook can't be trusted"
          sealProblem = why
          return .problem(why)
        }
        // opened and read again after the check, and the files must not have been touched since before it: what was sealed is what is kept
        guard case .success(let after) = Self.load(script: real, helper: helper), after.script.mark == files.script.mark,
          after.helper?.mark == files.helper?.mark, after.script.bytes == files.script.bytes, after.helper?.bytes == files.helper?.bytes,
          Self.sameState(after.state, files.state, exactly: true)
        else { return .problem(Self.changed(script)) }
        baseline = Baseline(
          path: real, script: after.script.mark, helper: after.helper?.mark, scriptBytes: after.script.bytes, helperBytes: after.helper?.bytes,
          state: after.state)
        return .ok(.init(path: real, script: after.script.bytes, helper: after.helper?.bytes, state: after.state?.mapValues(\.bytes)))
      }
      guard base.path == real, base.script.sameFile(files.script.mark), (base.helper == nil) == (files.helper == nil),
        base.helper.map({ b in files.helper.map { b.sameFile($0.mark) } ?? false }) ?? true,
        files.script.bytes == base.scriptBytes, files.helper?.bytes == base.helperBytes, Self.sameState(base.state, files.state, exactly: false)
      else { return .problem(Self.changed(script)) }
      return .ok(.init(path: real, script: files.script.bytes, helper: files.helper?.bytes, state: files.state?.mapValues(\.bytes)))
    }

    /// The thread-state files of two looks: the same names, and each the same file (`exactly`: down to the status change, as at the
    /// check itself) with the same bytes. Both none is the same.
    private static func sameState(_ a: [String: File]?, _ b: [String: File]?, exactly: Bool) -> Bool {
      guard let a, let b else { return a == nil && b == nil }
      guard Set(a.keys) == Set(b.keys) else { return false }
      return a.allSatisfy { k, f in
        guard let o = b[k] else { return false }
        return f.bytes == o.bytes && (exactly ? f.mark == o.mark : f.mark.sameFile(o.mark))
      }
    }

    private static func isLink(_ p: String) -> String { "the Talos app's \(p) is a link, not part of the signed app" }

    private static func changed(_ script: String) -> String {
      "the permission hook \(script) changed after the app's signature was checked (quit and reopen Talos if it was just updated)"
    }

    private static func real(_ p: String) -> String? {
      guard let r = realpath(p, nil) else { return nil }
      defer { free(r) }
      return String(cString: r)
    }

    private struct Why: Error { var text: String }

    /// One file as one open read it: what it was, and its bytes.
    private struct File {
      var mark: Mark
      var bytes: Data
    }
    private typealias Loaded = (script: File, helper: File?, state: [String: File]?)

    /// Why the folder the hook is in is not one the app's files can be trusted in, or nil: a real folder (no link), of this account
    /// or root, that no other account can write (R1-5). A folder others can write lets them swap the file's name for another file.
    private static func folderProblem(_ d: String) -> String? {
      var st = stat()
      guard lstat(d, &st) == 0 else { return "the permission hook's folder \(d) is missing or cannot be read" }
      guard st.st_mode & S_IFMT == S_IFDIR else { return isLink(d) }
      guard st.st_uid == getuid() || st.st_uid == 0 else { return "the Talos app's \(d) belongs to another account" }
      guard st.st_mode & 0o022 == 0 else { return "the Talos app's \(d) can be written by other accounts, so the app's copy is not sealed" }
      return nil
    }

    /// The two files as they are now, each opened once and never through a link (R1-4): a plain file nobody may write to, owned by
    /// this account or root, with the bytes that same open file holds. Asked of the open file (`fstat`), not of its name again, and
    /// the file must be the same before and after the read. No helper at all is allowed (the hook runs without it).
    private static func load(script: String, helper: String) -> Result<Loaded, Why> {
      func one(_ p: String, optional: Bool) -> Result<File?, Why> {
        let missing = Why(text: "the permission hook \(p) is missing or cannot be read")
        // O_NONBLOCK: a FIFO put at the name must not hold the start; it is refused as not a file just below
        let fd = open(p, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else {
          if errno == ELOOP { return .failure(Why(text: isLink(p))) }
          return optional && errno == ENOENT ? .success(nil) : .failure(missing)
        }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        var st = stat()
        guard fstat(fd, &st) == 0 else { return .failure(missing) }
        guard st.st_mode & S_IFMT == S_IFREG else { return .failure(Why(text: "the permission hook \(p) is not a file")) }
        guard st.st_mode & 0o222 == 0 else { return .failure(Why(text: "the Talos app's \(p) can be written, so the app's copy is not sealed")) }
        guard st.st_uid == getuid() || st.st_uid == 0 else { return .failure(Why(text: "the Talos app's \(p) belongs to another account")) }
        let mark = Mark(st)
        var after = stat()
        guard let bytes = try? handle.readToEnd() ?? Data(), fstat(fd, &after) == 0, Mark(after) == mark, Int64(bytes.count) == mark.size else {
          return .failure(Why(text: changed(p)))
        }
        return .success(File(mark: mark, bytes: bytes))
      }
      // the thread-state files beside them, each held to the same rules as the hook (a bad one refuses the start, never skips it);
      // all of them and the helper they import, or none
      let folder = (script as NSString).deletingLastPathComponent
      var found: [String: File] = [:]
      for name in WorkerHook.stateFileNames {
        switch one(folder + "/" + name, optional: true) {
        case .failure(let w): return .failure(w)
        case .success(let f): if let f { found[name] = f }
        }
      }
      switch (one(script, optional: false), one(helper, optional: true)) {
      case (.failure(let w), _), (_, .failure(let w)): return .failure(w)
      case (.success(let s), .success(let h)):
        guard let s else { return .failure(Why(text: "the permission hook \(script) is missing or cannot be read")) }
        return .success((s, h, h != nil && found.count == WorkerHook.stateFileNames.count ? found : nil))
      }
    }
  }
}
