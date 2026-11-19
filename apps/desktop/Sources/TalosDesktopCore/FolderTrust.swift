import Foundation

/// Folder trust, answered by the owner's own choice of folder (the Linux twin is apps/bridge/src/supervisor/folder-trust.ts). A thread
/// session that starts in a folder Claude Code has not seen stops on "Do you trust the files in this folder?"; the owner picking that
/// folder for the thread is the consent, so the supervisor records it where Claude Code does when a person says yes: the project entry in
/// Claude Code's global config, `projects[<absolute folder>].hasTrustDialogAccepted = true` in `<config home>/.claude.json` (read from
/// Claude Code 2.1.328's own file on the owner's Mac).
///
/// Narrow, and every rule is checked here whoever calls: only the thread's own folder as its resolved real path, and only when it is a
/// folder the owner set for a thread (`chosen`); never the home folder, a parent of anything, a folder holding the Talos data or the agent
/// folder, nor the agent folder itself (Main's trust is first-start's, which proves the folder first); never through a link (a configured
/// folder that is a link into its own parent is refused). Only the one key is changed: the file is read, the key set, the rest written back
/// as read into a temp file beside it with the file's own mode, and renamed over it. Claude Code rewrites the file itself at any time, so
/// it is read again just before the rename (changed: start over) and once after it (the key must be there and nothing else changed).
///
/// All under Claude Code's own lock. Claude Code 2.1.328 saves the file in `saveConfigWithLock` with proper-lockfile on `<config file>.lock`
/// (read from the binary: `lockfilePath: `${file}.lock``, a lock folder made by mkdir, ELOCKED when held, stale after 10 s and kept fresh by its
/// holder). This takes that same lock around read, modify and rename; a held lock is waited for a moment (`lockDelays`) and never taken over:
/// no lock, no write, and the prompt card is the way out.
public enum FolderTrust {
  public enum Result: Equatable, Sendable {
    case wrote
    /// Already accepted: nothing was written.
    case already
    /// Not done, and why. The start goes on; the question on the pane then reaches the phone as a card.
    case refused(String)
  }

  /// Tries made while another writer keeps changing the file.
  public static let tries = 5
  /// The waits (seconds, each stretched by up to 2x) between looks at a lock Claude Code holds: about 1.5 s in all, then it gives up.
  public static let lockDelays: [Double] = [0.02, 0.04, 0.08, 0.16, 0.32, 0.64]
  static let maxBytes = 32 * 1024 * 1024

  /// Claude Code's global config for a config home (`CLAUDE_CONFIG_DIR` when set, else the home folder).
  public static func configFile(configHome: String) -> String {
    var h = configHome
    while h.count > 1, h.hasSuffix("/") { h.removeLast() }
    return (h == "/" ? "" : h) + "/.claude.json"
  }

  private static func real(_ p: String) -> String? {
    guard let r = realpath(p, nil) else { return nil }
    defer { free(r) }
    var s = String(cString: r)
    while s.count > 1, s.hasSuffix("/") { s.removeLast() }
    return s
  }

  private static func within(_ p: String, _ root: String) -> Bool { p == root || p.hasPrefix(root == "/" ? "/" : root + "/") }

  /// Why `folder` may not be trusted for the owner's choice, nil when it may. Pure but for realpath.
  public static func refusal(folder f: String, chosen: [String], home: String, talosHome: String, agentDir: String) -> String? {
    let unsendable = f.unicodeScalars.contains { $0.value < 0x20 || $0.value == 0x7f }
    guard f.hasPrefix("/"), !f.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0 == "." || $0 == ".." }),
      f.utf16.count <= 512, !unsendable
    else { return "the folder is not a plain absolute path" }
    guard let r = real(f) else { return "the folder does not exist" }
    var trimmed = f
    while trimmed.count > 1, trimmed.hasSuffix("/") { trimmed.removeLast() }
    if r != trimmed { return "the folder is not its own real path (a link)" }
    guard let h = real(home), within(r, h), r != h else { return "the folder is not inside the home folder" }
    if within(r, h + "/.claude") { return "the folder is inside ~/.claude" }
    let talos = real(talosHome) ?? talosHome
    if within(r, talos) || within(talos, r) { return "the folder holds, or is inside, the Talos data folder" }
    if let a = real(agentDir), within(a, r) {
      return "the folder is the agent folder or one that holds it (Main's trust is its own first start's)"
    }
    let mine = chosen.filter { $0.hasPrefix("/") && real($0) == r }
    if mine.isEmpty { return "the folder is not one the owner chose for a thread" }
    // a configured folder written as a path that is a link leading up into its own parent is a trick, not a choice
    let lexical = mine.map { c -> String in
      var s = c
      while s.count > 1, s.hasSuffix("/") { s.removeLast() }
      return s
    }
    if lexical.allSatisfy({ within($0, r) && $0 != r }) { return "the configured folder is a link into its own parent" }
    return nil
  }

  private struct Snapshot {
    let raw: Data
    let object: [String: Any]
    let mode: mode_t
  }

  private static func read(_ file: String) -> Snapshot? {
    let fd = open(file, O_RDONLY)
    guard fd >= 0 else { return nil }
    defer { close(fd) }
    var st = stat()
    guard fstat(fd, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG, st.st_size <= maxBytes else { return nil }
    var data = Data()
    var buf = [UInt8](repeating: 0, count: 64 * 1024)
    while true {
      let n = Darwin.read(fd, &buf, buf.count)
      if n < 0 { return nil }
      if n == 0 { break }
      data.append(contentsOf: buf[0..<n])
    }
    guard let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
    return Snapshot(raw: data, object: obj, mode: st.st_mode & 0o777)
  }

  private static func accepted(_ s: Snapshot, _ folder: String) -> Bool? {
    guard let projects = s.object["projects"] as? [String: Any] else { return false }
    guard let entry = projects[folder] else { return false }
    guard let e = entry as? [String: Any] else { return nil }
    return (e["hasTrustDialogAccepted"] as? Bool) == true
  }

  /// Sets `projects[folder].hasTrustDialogAccepted = true`, when the rules above allow. `beforeRename` is a test seam (a concurrent writer
  /// lands between the read and the rename).
  public static func preAccept(
    configFile: String, folder: String, chosen: [String], home: String, talosHome: String, agentDir: String,
    beforeRename: (() -> Void)? = nil, wait: (Double) -> Void = { usleep(UInt32($0 * 1_000_000)) }
  ) -> Result {
    if let why = refusal(folder: folder, chosen: chosen, home: home, talosHome: talosHome, agentDir: agentDir) { return .refused(why) }
    // a config that is itself a link (dotfiles) is written where it really is, so the link stays a link
    guard let file = real(configFile) else { return .refused("Claude Code has no config file here yet, so nothing was written") }
    // Claude Code names its lock after the path it was given, not the one it resolves to
    let lock = configFile + ".lock"
    var k = 0
    while mkdir(lock, 0o777) != 0 {
      guard errno == EEXIST else { return .refused("Claude Code's config lock could not be taken (\(String(cString: strerror(errno))))") }
      guard k < lockDelays.count else { return .refused("Claude Code is saving its config right now (its lock is held), so trust was not recorded") }
      wait(lockDelays[k] * Double.random(in: 1...2))
      k += 1
    }
    defer { rmdir(lock) }  // already gone (Claude Code's own stale rule took it): nothing of ours is left
    return write(file: file, folder: folder, beforeRename: beforeRename)
  }

  private static func write(file: String, folder: String, beforeRename: (() -> Void)?) -> Result {
    for _ in 0..<tries {
      guard let cur = read(file) else { return .refused("the Claude Code config cannot be read as a JSON object, so it was left as it is") }
      if let p = cur.object["projects"], !(p is [String: Any]) {
        return .refused("the Claude Code config's projects is not an object, so it was left as it is")
      }
      guard let have = accepted(cur, folder) else {
        return .refused("the folder's entry in the Claude Code config is not an object, so it was left as it is")
      }
      if have { return .already }
      var object = cur.object
      var projects = (object["projects"] as? [String: Any]) ?? [:]
      var entry = (projects[folder] as? [String: Any]) ?? [:]
      entry["hasTrustDialogAccepted"] = true
      projects[folder] = entry
      object["projects"] = projects
      guard var out = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .withoutEscapingSlashes]) else {
        return .refused("the Claude Code config could not be written back")
      }
      if cur.raw.last == 0x0A { out.append(0x0A) }
      let dir = (file as NSString).deletingLastPathComponent
      let tmp = dir + "/.claude.json.tmp.\(getpid()).\(String(UInt32.random(in: 0...UInt32.max), radix: 16))"
      let fd = open(tmp, O_WRONLY | O_CREAT | O_EXCL, cur.mode)
      guard fd >= 0 else { return .refused("the Claude Code config could not be written (\(String(cString: strerror(errno))))") }
      var ok = true
      out.withUnsafeBytes { buf in
        var off = 0
        while off < buf.count {
          let n = Darwin.write(fd, buf.baseAddress! + off, buf.count - off)
          if n <= 0 { ok = false; break }
          off += n
        }
      }
      fchmod(fd, cur.mode)
      if fsync(fd) != 0 { ok = false }
      close(fd)
      guard ok else {
        unlink(tmp)
        return .refused("the Claude Code config could not be written (disk)")
      }
      beforeRename?()
      // another writer (Claude Code rewrites this file itself): what is there now must be what this was made from
      guard let now = read(file) else {
        unlink(tmp)
        return .refused("the Claude Code config changed under the write and can no longer be read, so it was left as it is")
      }
      if now.raw != cur.raw {
        unlink(tmp)
        continue
      }
      guard rename(tmp, file) == 0 else {
        unlink(tmp)
        return .refused("the Claude Code config could not be written (\(String(cString: strerror(errno))))")
      }
      // after the write: the key must be there (a writer that held the old text in memory may have put it back)
      // and everything else, at every depth, is what was read plus that one key
      if let after = read(file), let want = try? JSONSerialization.jsonObject(with: out) as? [String: Any],
        after.object as NSDictionary == want as NSDictionary
      {
        return .wrote
      }
    }
    return .refused("the Claude Code config kept changing under the write, so trust was not recorded")
  }
}
