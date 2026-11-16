import Foundation
import Testing
@testable import TalosDesktopCore
import TalosTestSupport

/// How many times the signature check was asked, and what it answers.
final class CountingSeal: @unchecked Sendable {
  private let lock = NSLock()
  private var n = 0
  private var asked: [String] = []
  var answer: String?
  var during: (@Sendable () -> Void)?
  init(_ answer: String? = nil) { self.answer = answer }
  var count: Int { lock.withLock { n } }
  var paths: [String] { lock.withLock { asked } }
  func check(_ bundle: String) -> String? {
    lock.withLock {
      n += 1
      asked.append(bundle)
    }
    during?()
    return answer
  }
}

/// Where a thread session's permission hook comes from (`WorkerHook.BundleSource`, review R1-1): the app bundle's sealed copy and
/// nothing else. The hook answers a thread session's approval prompts, so a copy that session could have written must never be run:
/// one outside the bundle (the checkout the app was built from, where the app used to look), one with a write bit, one in a bundle
/// whose signature fails, and one that is not the file the signature check saw are each refused, and nothing is copied.
@Suite("WorkerHook: the source is the app bundle's sealed copy")
struct WorkerHookSourceTests {
  let root: String
  let app: FakeAppBundle
  var talosHome: String { root + "/talos home" }
  var copy: String { talosHome + "/workers/_hook/permission-relay.py" }
  let path = "/usr/bin:/bin"

  init() throws {
    let base = (TestTemp.base as NSString).appendingPathComponent("talos-hooksrc-\(UUID().uuidString.prefix(8))")
    try FileManager.default.createDirectory(atPath: base, withIntermediateDirectories: true)
    root = try TestTemp.real(base)  // realpath: the code answers with real paths (R1-3)
    try FileManager.default.createDirectory(atPath: root + "/talos home", withIntermediateDirectories: true)
    app = try FakeAppBundle(in: root, script: Data("print('hook')\n".utf8), helper: Data("HELPER = 1\n".utf8))
  }

  func source(_ seal: CountingSeal = CountingSeal(), script: String? = nil) -> WorkerHook.BundleSource {
    .init(script: script ?? app.script, bundlePath: app.path, seal: { seal.check($0) })
  }

  /// Refused with this reason by the preflight and by the install, and nothing was written.
  func refused(_ s: WorkerHook.BundleSource, _ why: String, sourceLocation: SourceLocation = #_sourceLocation) {
    #expect(WorkerHook.problem(source: s, path: path, talosHome: talosHome) == why, sourceLocation: sourceLocation)
    #expect(WorkerHook.install(talosHome: talosHome, source: s, path: path) == .problem(why), sourceLocation: sourceLocation)
    #expect(!FileManager.default.fileExists(atPath: copy), "nothing was copied", sourceLocation: sourceLocation)
  }

  @Test func theBundledHookAndItsHelperAreCopiedAndTheSignatureIsCheckedOncePerRun() throws {
    let seal = CountingSeal()
    let s = source(seal)
    #expect(WorkerHook.problem(source: s, path: path, talosHome: talosHome) == nil)
    for _ in 0..<3 {
      guard case .installed = WorkerHook.install(talosHome: talosHome, source: s, path: path) else {
        Issue.record("not installed")
        return
      }
    }
    #expect(seal.count == 1, "asked once, however many starts: \(seal.count)")
    #expect(seal.paths == [app.path], "and asked about the app bundle itself")
    #expect(try String(contentsOfFile: copy, encoding: .utf8) == "print('hook')\n")
    #expect(try String(contentsOfFile: talosHome + "/workers/_hook/_talos_common.py", encoding: .utf8) == "HELPER = 1\n")
  }

  /// The hole this closes: the hook named in the checkout the app was built from. Read-only and readable, and still refused.
  @Test func aHookOutsideTheAppBundleIsRefused() throws {
    let kit = root + "/checkout/kit/hooks"
    try FileManager.default.createDirectory(atPath: kit, withIntermediateDirectories: true)
    try FakeAppBundle.put(Data("print('mine')\n".utf8), at: kit + "/permission-relay.py")
    let outside = kit + "/permission-relay.py"
    refused(source(script: outside), "the permission hook \(outside) is not inside the Talos app (\(app.path))")
    // a link inside the bundle is refused for being a link, wherever it leads
    unlink(app.script)
    try FileManager.default.createSymbolicLink(atPath: app.script, withDestinationPath: outside)
    refused(source(), "the Talos app's \(app.script) is a link, not part of the signed app")
    // and a linked FOLDER on the way to it, leading out of the bundle, is where the file really is
    try FileManager.default.removeItem(atPath: app.hooks)
    try FileManager.default.createSymbolicLink(atPath: app.hooks, withDestinationPath: kit)
    refused(source(), "the permission hook \(app.script) is not inside the Talos app (\(app.path))")
    // a folder whose name only starts like the bundle's is not the bundle
    let twin = app.path + "-old/Contents/Resources/talos-hooks"
    try FileManager.default.createDirectory(atPath: twin, withIntermediateDirectories: true)
    try FakeAppBundle.put(Data("print('twin')\n".utf8), at: twin + "/permission-relay.py")
    refused(source(script: twin + "/permission-relay.py"), "the permission hook \(twin)/permission-relay.py is not inside the Talos app (\(app.path))")
  }

  /// An app inside the starting thread's folder or the agent folder (a build left in the checkout a thread works in) is refused
  /// for that thread: the thread edits files there without a prompt. The same app is fine for a thread working elsewhere.
  @Test func anAppInsideAFolderAThreadSessionWorksInIsRefusedForThatThread() throws {
    let s = source()
    let why = "the Talos app \(app.path) is inside \(root), a folder a thread session works in"
    #expect(WorkerHook.problem(source: s, path: path, talosHome: talosHome, fenced: ["/home/alex/agent", root]) == why)
    #expect(WorkerHook.install(talosHome: talosHome, source: s, path: path, fenced: [root]) == .problem(why))
    #expect(!FileManager.default.fileExists(atPath: copy), "nothing was copied")
    // through a link to that folder too
    try FileManager.default.createSymbolicLink(atPath: root + "-link", withDestinationPath: root)
    defer { unlink(root + "-link") }
    #expect(WorkerHook.problem(source: s, path: path, talosHome: talosHome, fenced: [root + "-link"]) == why)
    #expect(WorkerHook.problem(source: s, path: path, talosHome: talosHome, fenced: [root + "/elsewhere", root + "/Talos"]) == nil, "another thread's folder")
  }

  @Test(arguments: [0o644, 0o464, 0o446] as [mode_t])
  func aHookAnyoneCanWriteToIsRefused(mode: mode_t) {
    chmod(app.script, mode)
    refused(source(), "the Talos app's \(app.script) can be written, so the app's copy is not sealed")
    chmod(app.script, 0o444)
    chmod(app.helper, mode)
    refused(source(), "the Talos app's \(app.helper) can be written, so the app's copy is not sealed")
  }

  /// R1-5: the folder the hook is in. One another account can write lets that account put another file under the hook's name, so
  /// it is refused; so is one that belongs to nobody this app trusts. The owner's own write bit is how the folder is built.
  @Test(arguments: [0o775, 0o757, 0o777] as [mode_t])
  func aHookInAFolderOtherAccountsCanWriteIsRefused(mode: mode_t) {
    chmod(app.hooks, mode)
    defer { chmod(app.hooks, 0o755) }
    refused(source(), "the Talos app's \(app.hooks) can be written by other accounts, so the app's copy is not sealed")
    chmod(app.hooks, 0o755)
    #expect(WorkerHook.problem(source: source(), path: path, talosHome: talosHome) == nil, "control: the folder as the build leaves it passes")
    chmod(app.hooks, 0o555)
    #expect(WorkerHook.problem(source: source(), path: path, talosHome: talosHome) == nil, "and one nobody can write")
  }

  /// A name that is not a file at all: a FIFO where the helper goes would hold a plain read for ever. It is refused at once.
  @Test func aFifoUnderTheHelpersNameIsRefusedAndHoldsNothing() throws {
    unlink(app.helper)
    #expect(mkfifo(app.helper, 0o444) == 0)
    let began = Date()
    refused(source(), "the permission hook \(app.helper) is not a file")
    #expect(Date().timeIntervalSince(began) < 5)
  }

  /// R1-4: the file that is checked is the file that is read. While one thread swaps the hook's FOLDER back and forth with another
  /// (one step each way, so the name is never missing, and the sealed file itself is never touched: it looks the same before and
  /// after), whose hook has a write bit and other bytes, every answer is either a refusal or the sealed file's bytes. A look at the
  /// name, then a read of the name, then a look again hands back the other file's bytes whenever the swaps fall between them; asked
  /// of one open file there is no "between".
  @Test func theBytesHandedBackAreAlwaysThoseOfTheFileThatWasChecked() throws {
    let good = Data("print('hook')\n".utf8), evil = Data("print('evil')\n".utf8)
    let other = app.path + "/Contents/Resources/talos-hooks-other"
    try FileManager.default.createDirectory(atPath: other, withIntermediateDirectories: true)
    try evil.write(to: URL(fileURLWithPath: other + "/permission-relay.py"))
    chmod(other + "/permission-relay.py", 0o644)
    try Data("HELPER = 2\n".utf8).write(to: URL(fileURLWithPath: other + "/_talos_common.py"))
    let stop = Mutexed(false)
    let hooks = app.hooks
    let swapper = Thread {
      var swaps = 0
      while !stop.with({ $0 }) {
        if renamex_np(hooks, other, UInt32(RENAME_SWAP)) == 0 { swaps += 1 }
      }
      if swaps % 2 == 1 { _ = renamex_np(hooks, other, UInt32(RENAME_SWAP)) }  // the sealed folder back under its own name
    }
    swapper.start()
    defer {
      stop.with { $0 = true }
      while !swapper.isFinished { usleep(1000) }
    }
    var ok = 0, wrong = 0
    var refusals: [String: Int] = [:]
    let until = Date().addingTimeInterval(3)
    var looks = 0
    while looks < 20000, Date() < until || ok == 0, Date() < until.addingTimeInterval(20) {
      looks += 1
      // a new source each time: the first look of a run, where nothing is kept from before to compare with
      switch source().verified() {
      case .ok(let v):
        ok += 1
        if v.script != good { wrong += 1 }
      case .problem(let why): refusals[why, default: 0] += 1
      }
    }
    #expect(wrong == 0, "\(wrong) of \(ok) answers handed back the bytes of a file that fails the check")
    #expect(ok > 0, "control: the sealed file was seen at all in \(looks) looks: \(refusals)")
    #expect(refusals.keys.contains { $0.contains("can be written") }, "control: the other file was met too: \(refusals)")
  }

  @Test func aHelperThatIsALinkIsRefused() throws {
    unlink(app.helper)
    try FakeAppBundle.put(Data("EVIL = 1\n".utf8), at: root + "/elsewhere.py")
    try FileManager.default.createSymbolicLink(atPath: app.helper, withDestinationPath: root + "/elsewhere.py")
    refused(source(), "the Talos app's \(app.helper) is a link, not part of the signed app")
  }

  /// A failed check is the answer for the whole run: asked once, never asked again in the hope of another answer.
  @Test func aBundleWhoseSignatureFailsIsRefusedAndTheAnswerIsKept() {
    let seal = CountingSeal("a sealed resource is missing or invalid, -67054")
    let s = source(seal)
    let why = "the Talos app's code signature does not check out (a sealed resource is missing or invalid, -67054), so its permission hook can't be trusted"
    refused(s, why)
    seal.answer = nil
    refused(s, why)
    #expect(seal.count == 1)
    #expect(WorkerHook.BundleSource(script: nil, bundlePath: app.path, seal: { _ in nil }).verified() == .problem(WorkerHook.noBundledHook))
  }

  /// After the check: an edit in place (the inode stays; the modification time is put back, as `touch -r` would), a file swapped in
  /// (another inode, the same time and size), and a helper that comes or goes. Each is refused; the copy stays what was checked.
  @Test(arguments: ["edit-in-place-time-restored", "swapped-same-size", "helper-removed", "helper-edited", "same-bytes-new-file"])
  func aHookThatIsNotTheOneTheCheckSawIsRefused(kind: String) throws {
    let s = source()
    guard case .installed = WorkerHook.install(talosHome: talosHome, source: s, path: path) else {
      Issue.record("not installed")
      return
    }
    var st = stat()
    #expect(stat(app.script, &st) == 0)
    let times = [st.st_atimespec, st.st_mtimespec]
    switch kind {
    case "edit-in-place-time-restored":
      try FakeAppBundle.overwrite(app.script, with: "print('evil')\n")
      #expect(utimensat(AT_FDCWD, app.script, times, 0) == 0)
    case "swapped-same-size", "same-bytes-new-file":
      unlink(app.script)
      try FakeAppBundle.put(Data((kind == "same-bytes-new-file" ? "print('hook')\n" : "print('evil')\n").utf8), at: app.script)
      #expect(utimensat(AT_FDCWD, app.script, times, 0) == 0)
    case "helper-removed": unlink(app.helper)
    default: try FakeAppBundle.overwrite(app.helper, with: "HELPER = 2\n")
    }
    let why = "the permission hook \(app.script) changed after the app's signature was checked (quit and reopen Talos if it was just updated)"
    #expect(WorkerHook.problem(source: s, path: path, talosHome: talosHome) == why)
    #expect(WorkerHook.install(talosHome: talosHome, source: s, path: path) == .problem(why))
    #expect(try String(contentsOfFile: copy, encoding: .utf8) == "print('hook')\n", "the copy is still the hook that was checked")
    #expect(try String(contentsOfFile: talosHome + "/workers/_hook/_talos_common.py", encoding: .utf8) == "HELPER = 1\n")
  }

  /// CONTROL for the test above: the same source asked again with nothing touched keeps passing, so that test's refusals are the edits.
  @Test func controlAnUntouchedHookKeepsPassing() {
    let s = source()
    for _ in 0..<3 { #expect(WorkerHook.problem(source: s, path: path, talosHome: talosHome) == nil) }
  }

  /// The file edited while the signature is being checked (the check read the sealed text, the copy would read the edit): refused,
  /// and that answer is not kept as a pass. Once the file holds still, a new check is made.
  @Test func aHookEditedDuringTheSignatureCheckIsRefused() throws {
    let seal = CountingSeal()
    let script = app.script
    seal.during = { try? FakeAppBundle.overwrite(script, with: "print('evil')\n") }
    let s = source(seal)
    refused(s, "the permission hook \(app.script) changed after the app's signature was checked (quit and reopen Talos if it was just updated)")
    seal.during = nil
    seal.answer = "a sealed resource is missing or invalid"
    refused(s, "the Talos app's code signature does not check out (a sealed resource is missing or invalid), so its permission hook can't be trusted")
    #expect(seal.count >= 2, "the first answer was not kept as a pass")
  }

  /// Two starts at once on one source: one check, both get the same hook.
  @Test func twoStartsAtOnceMakeOneCheck() {
    let seal = CountingSeal()
    seal.during = { usleep(100_000) }
    let s = source(seal)
    let answers = Mutexed<[WorkerHook.BundleSource.Answer]>([])
    DispatchQueue.concurrentPerform(iterations: 8) { _ in
      let a = s.verified()
      answers.with { $0.append(a) }
    }
    #expect(seal.count == 1)
    #expect(answers.with { $0 }.allSatisfy { if case .ok = $0 { true } else { false } })
  }
}

private final class Mutexed<T>: @unchecked Sendable {
  private let lock = NSLock()
  private var value: T
  init(_ v: T) { value = v }
  func with<R>(_ body: (inout T) -> R) -> R { lock.withLock { body(&value) } }
}
