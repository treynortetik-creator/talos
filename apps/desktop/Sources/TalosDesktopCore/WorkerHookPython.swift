import Foundation

/// The python3 that runs a thread session's permission hook: which file it may be, and which it may never be. The hook answers the
/// thread's approval prompts, so the program that runs it must be one no thread session can write or steer:
///  - never inside a folder a thread session works in. Not the starting thread's and not ANY thread's (R1-2): thread B edits files
///    in its own folder without a prompt, and a python3 there would run thread A's hook;
///  - never inside the owner's home at all. Every thread folder is inside the home, so a python3 there (pyenv's, a venv's, conda's)
///    could become a thread's own the day a thread is given that folder, and no start would look at it again;
///  - never Apple's /usr/bin/python3. That file is not an interpreter: it is the `xcrun` launcher, and it runs whatever
///    `DEVELOPER_DIR` names (R1-1). The developer tools' real interpreter is found once per start and named by its own path;
///  - a real program (Mach-O), named python3, that not every account can write. A `#!` script or a version manager's shim reads its
///    choice from the folder it runs in.
/// The look is made at every start, so a python3 that was fine at the last start is held to the same rules again.
/// The Linux twin's findPython3 (worker-hook.ts) has the first rule for its own start and the shim rule; the rest is the Mac's.
extension WorkerHook {
  public struct PythonRules: Sendable {
    /// Every thread's folder (from the agent config, and of every session this app has made), besides the start's own `fenced`.
    public var folders: [String]
    /// The owner's home: no python3 inside it runs the hook. nil = no such rule (a test whose temp folder is inside a home).
    public var home: String?
    /// Where the developer tools' real python3 is looked for when the PATH has only Apple's launcher. nil = this Mac's
    /// (`developerPythons`).
    public var developer: [String]?

    public init(folders: [String] = [], home: String? = NSHomeDirectory(), developer: [String]? = nil) {
      self.folders = folders
      self.home = home
      self.developer = developer
    }
  }

  /// The developer tools' python3, in the order `xcrun` would pick: the selected tools (`xcode-select`'s link, which only root can
  /// change), then the Command Line Tools, then Xcode. Read from the disk, never by running `xcrun`: nothing is run to choose the
  /// program that answers prompts.
  public static func developerPythons(selected link: String = "/var/db/xcode_select_link") -> [String] {
    var dirs: [String] = []
    if let chosen = try? FileManager.default.destinationOfSymbolicLink(atPath: link), chosen.hasPrefix("/") { dirs.append(chosen) }
    dirs += ["/Library/Developer/CommandLineTools", "/Applications/Xcode.app/Contents/Developer"]
    return dirs.map { $0 + "/usr/bin/python3" }
  }

  /// The first python3 on `path` that the rules above allow, from an absolute entry that is not, and does not lead, inside any of
  /// `fenced` (the starting thread's folder, the agent folder) or `rules.folders` (R1-7, R1-2). Its links are followed and the REAL
  /// file is returned (what the command runs). An empty or relative entry is the thread folder at run time, so it is never used
  /// either. When the PATH's only python3 is Apple's launcher, the developer tools' real interpreter is returned in its place, or
  /// nothing when there is none (the launcher would only offer to install them).
  public static func findPython3(path: String?, fenced: [String] = [], rules: PythonRules = .init()) -> String? {
    let walls = (fenced + rules.folders + (rules.home.map { [$0] } ?? [])).filter { $0.hasPrefix("/") }.compactMap { resolved($0)?.lowercased() }
    // compared without case, as the Mac's file system is: `/Home/Alex/x` and `/home/alex/x` are one folder
    func within(_ p: String, _ folder: String) -> Bool { p == folder || p.hasPrefix(folder.hasSuffix("/") ? folder : folder + "/") }
    func walled(_ p: String) -> Bool { walls.contains { within(p.lowercased(), $0) } }
    var launcherSeen = false
    for d in (path ?? "").split(separator: ":", omittingEmptySubsequences: false) where d.hasPrefix("/") {
      let p = d.hasSuffix("/") ? "\(d)python3" : "\(d)/python3"
      var st = stat()
      guard stat(p, &st) == 0, st.st_mode & S_IFMT == S_IFREG, access(p, X_OK) == 0 else { continue }
      guard let realDir = resolved(String(d)), let realBin = resolved(p) else { continue }
      if walled(realDir) || walled(realBin) { continue }
      if isXcrunLauncher(realBin) {
        launcherSeen = true
        continue
      }
      guard isInterpreter(realBin) else { continue }
      return realBin
    }
    guard launcherSeen else { return nil }
    for candidate in rules.developer ?? developerPythons() where candidate.hasPrefix("/") {
      var st = stat()
      guard stat(candidate, &st) == 0, st.st_mode & S_IFMT == S_IFREG, access(candidate, X_OK) == 0 else { continue }
      guard let realBin = resolved(candidate), !walled(realBin), !isXcrunLauncher(realBin), isInterpreter(realBin) else { continue }
      return realBin
    }
    return nil
  }

  /// A real interpreter file: named python3, a Mach-O program (not a `#!` script, not anything else), and not writable by every
  /// account.
  static func isInterpreter(_ realBin: String) -> Bool {
    var st = stat()
    guard lstat(realBin, &st) == 0, st.st_mode & S_IFMT == S_IFREG, st.st_mode & 0o002 == 0 else { return false }
    return isPython3Name((realBin as NSString).lastPathComponent) && !isScript(realBin) && isMachO(realBin)
  }

  /// `python3`, `python3.13`, `python3.13.1`: the real file's name. A shim's real file is named for its manager.
  static func isPython3Name(_ name: String) -> Bool {
    guard name.hasPrefix("python3") else { return false }
    let rest = name.dropFirst("python3".count)
    if rest.isEmpty { return true }
    guard rest.hasPrefix(".") else { return false }
    return rest.dropFirst().split(separator: ".", omittingEmptySubsequences: false).allSatisfy { !$0.isEmpty && $0.allSatisfy { $0.isASCII && $0.isNumber } }
  }

  /// A `#!` script (a pyenv or asdf shim, a wrapper): it may pick its interpreter from the folder it is run in. A file that
  /// cannot be read counts as one.
  static func isScript(_ p: String) -> Bool {
    guard let h = FileHandle(forReadingAtPath: p) else { return true }
    defer { try? h.close() }
    guard let head = try? h.read(upToCount: 2) else { return true }
    return head == Data("#!".utf8)
  }

  /// A Mach-O program, thin or universal, by its first four bytes. A file that cannot be read is not one.
  static func isMachO(_ p: String) -> Bool {
    guard let h = FileHandle(forReadingAtPath: p) else { return false }
    defer { try? h.close() }
    guard let head = try? h.read(upToCount: 4), head.count == 4 else { return false }
    let magics: [[UInt8]] = [
      [0xCF, 0xFA, 0xED, 0xFE], [0xFE, 0xED, 0xFA, 0xCF], [0xCE, 0xFA, 0xED, 0xFE], [0xFE, 0xED, 0xFA, 0xCE], [0xCA, 0xFE, 0xBA, 0xBE],
      [0xCA, 0xFE, 0xBA, 0xBF],
    ]
    return magics.contains(Array(head))
  }

  /// Apple's launcher for the developer tools (`/usr/bin/python3`, and `git`, `make` and the rest beside it): one small program
  /// that asks `xcrun` for the tool of its own name, and `xcrun` takes the tools' folder from `DEVELOPER_DIR`. Known by where it is
  /// (anything in /usr/bin) and by what it is linked to (libxcselect), so a copy of it somewhere else is known too. A file that
  /// cannot be read counts as one.
  static func isXcrunLauncher(_ realBin: String) -> Bool {
    if realBin.hasPrefix("/usr/bin/") { return true }
    guard let h = FileHandle(forReadingAtPath: realBin) else { return true }
    defer { try? h.close() }
    // the launcher is about 120 KB; a real interpreter is never read past this
    guard let head = try? h.read(upToCount: 1 << 20) else { return true }
    return head.range(of: Data("libxcselect".utf8)) != nil
  }

  static func resolved(_ p: String) -> String? {
    guard let r = realpath(p, nil) else { return nil }
    defer { free(r) }
    return String(cString: r)
  }
}
