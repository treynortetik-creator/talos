import CryptoKit
import Foundation
import Security

/// The unsent text from Main's input box that an Update now saved, kept for the owner to read after the restart. It is only ever SHOWN
/// (plain text, with Copy and Dismiss); nothing ever types it back into the box, so a planted file cannot send a message as the owner.
public struct DraftNote: Codable, Equatable, Sendable {
  public var v: Int = 1
  /// The version the update was going to (the note is shown only after an update to this version really happened).
  public var version: String
  public var text: String
  /// The text came from reading the screen, and the screen can hide part of it (a paste placeholder, a box that fills the pane).
  public var partial: Bool
  public var saved_at: Double

  public static let maxBytes = 20_000
  public static let maxChars = 8_000
  /// A note nobody dismissed is deleted after this long.
  public static let keepFor: Double = 24 * 3600

  public init(version: String, text: String, partial: Bool, saved_at: Double) {
    self.version = version
    self.text = text
    self.partial = partial
    self.saved_at = saved_at
  }

  /// Plain text for the screen: no control characters (a line break stays a space), at most `maxChars`.
  public static func clean(_ s: String) -> String {
    let t = String(s.unicodeScalars.map { CharacterSet.controlCharacters.contains($0) ? " " : Character($0) })
    return String(t.trimmingCharacters(in: .whitespaces).prefix(maxChars))
  }

  /// The screen shows a paste as a placeholder, not as its text: that text is not in what was read.
  public static func looksPartial(text: String, boxStartsAtTop: Bool) -> Bool {
    boxStartsAtTop || text.contains("[Pasted text #") || text.contains("[Image #")
  }

  /// sha256 over the version, the time and the clean text: what the Keychain holds, so a file the agent wrote (or edited) has no match.
  public var digest: String {
    let body = "\(version)\n\(saved_at.bitPattern)\n\(DraftNote.clean(text))"
    return SHA256.hash(data: Data(body.utf8)).map { String(format: "%02x", $0) }.joined()
  }

  /// Saves the note and its digest (in `digests`, a place the agent cannot write). False when either could not be saved.
  public static func write(_ n: DraftNote, to path: String, digests: any DraftDigestStore = DraftDigests.store) -> Bool {
    guard let d = try? JSONEncoder().encode(n), d.count <= maxBytes, digests.save(n.digest) else { return false }
    let dir = (path as NSString).deletingLastPathComponent
    guard (try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])) != nil,
      (try? AtomicFile.write(d, to: path, mode: 0o600)) != nil, let back = FileManager.default.contents(atPath: path), back == d
    else {
      digests.clear()
      return false
    }
    return true
  }

  /// The note for `version`, or nil: nothing there, not a small regular file of the owner's own, another version's, or older than
  /// `keepFor` (that one is deleted). Never throws and never returns text that is not clean.
  public static func read(
    path: String, forVersion version: String, now: Double = Date().timeIntervalSince1970, digests: any DraftDigestStore = DraftDigests.store
  ) -> DraftNote? {
    var st = stat()
    guard lstat(path, &st) == 0 else { return nil }
    guard (st.st_mode & S_IFMT) == S_IFREG, st.st_uid == getuid(), st.st_size <= off_t(maxBytes) else {
      try? FileManager.default.removeItem(atPath: path)
      return nil
    }
    guard let d = FileManager.default.contents(atPath: path), let n = try? JSONDecoder().decode(DraftNote.self, from: d) else {
      try? FileManager.default.removeItem(atPath: path)
      return nil
    }
    if now - n.saved_at > keepFor || now < n.saved_at - 600 {
      try? FileManager.default.removeItem(atPath: path)
      return nil
    }
    guard n.version == version else { return nil }
    var c = n
    c.text = clean(n.text)
    // only a note this app saved: the Keychain holds its digest, and the agent can write the file but not the Keychain item
    guard !c.text.isEmpty, let want = digests.read(), want == c.digest else { return nil }
    return c
  }

  /// The file and its digest, gone (Dismiss, a failed start, 24 hours).
  public static func remove(path: String, digests: any DraftDigestStore = DraftDigests.store) {
    try? FileManager.default.removeItem(atPath: path)
    digests.clear()
  }

  /// Deletes the file when it is older than `keepFor` (run at launch, so a note nobody dismissed does not stay for ever).
  public static func expire(path: String, now: Double = Date().timeIntervalSince1970, digests: any DraftDigestStore = DraftDigests.store) {
    guard let d = FileManager.default.contents(atPath: path), let n = try? JSONDecoder().decode(DraftNote.self, from: d) else {
      if FileManager.default.fileExists(atPath: path) { remove(path: path, digests: digests) }
      return
    }
    if now - n.saved_at > keepFor { remove(path: path, digests: digests) }
  }
}

/// Where the digest of the saved note is kept: out of the agent's reach (the app's own Keychain item).
public protocol DraftDigestStore: Sendable {
  func save(_ digest: String) -> Bool
  func read() -> String?
  func clear()
}

public enum DraftDigests {
  /// The app's store; tests put a memory store or a throwaway Keychain here.
  private static let lock = NSLock()
  nonisolated(unsafe) private static var current: any DraftDigestStore = KeychainDraftDigest()
  public static var store: any DraftDigestStore {
    get { lock.withLock { current } }
    set { lock.withLock { current = newValue } }
  }
}

/// One generic-password item of this app (service `com.talos.app.draft-copy`): the sha256 of the note that was saved last.
public struct KeychainDraftDigest: DraftDigestStore, @unchecked Sendable {
  public static let service = "com.talos.app.draft-copy"
  let item: KeychainItem
  public init(service: String = KeychainDraftDigest.service, keychain: SecKeychain? = nil) {
    item = KeychainItem(service: service, account: "v1", keychain: keychain)
  }
  public func save(_ digest: String) -> Bool {
    let (_, s) = item.read()
    let data = Data(digest.utf8)
    if s == errSecSuccess { return item.update(data) == errSecSuccess }
    guard s == errSecItemNotFound else { return false }
    return item.add(data) == errSecSuccess
  }
  public func read() -> String? {
    let (d, s) = item.read()
    guard s == errSecSuccess, let d else { return nil }
    return String(data: d, encoding: .utf8)
  }
  public func clear() { _ = item.delete() }
}

/// Holds the digest in memory (tests, and nothing else).
public final class MemoryDraftDigest: DraftDigestStore, @unchecked Sendable {
  private let lock = NSLock()
  private var value: String?
  public init() {}
  public func save(_ digest: String) -> Bool { lock.withLock { value = digest }; return true }
  public func read() -> String? { lock.withLock { value } }
  public func clear() { lock.withLock { value = nil } }
}

/// How an update's story ended, for the saved copy of the draft.
public enum DraftOutcome: Equatable, Sendable {
  /// The update happened and the new app is healthy.
  case updated
  /// The swap started and then failed or was rolled back: Main may have been restarted, so the text may be gone from its box.
  case triedAndFailed
  /// The swap provably never started (it could not be spawned): nothing quit, the text is still in the box.
  case neverStarted
}

/// The words of the notice, in one place.
public enum DraftNoticeCopy {
  public static let titleTried = "You had unsent text when Talos tried to update"
  /// "Talos saved this copy at 3:42 PM" (the time of day; the date too when it was not today).
  public static func saved(at t: Double, now: Double = Date().timeIntervalSince1970, locale: Locale = .current, timeZone: TimeZone = .current) -> String {
    let f = DateFormatter()
    f.locale = locale
    f.timeZone = timeZone
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = timeZone
    let sameDay = cal.isDate(Date(timeIntervalSince1970: t), inSameDayAs: Date(timeIntervalSince1970: now))
    f.dateStyle = sameDay ? .none : .medium
    f.timeStyle = .short
    return "Talos saved this copy at \(f.string(from: Date(timeIntervalSince1970: t)))"
  }
  public static let title = "You had unsent text when Talos updated"
  public static let partial = "This may be only part of what you typed."
  public static let copyButton = "Copy"
  public static let dismissButton = "Dismiss"
}
