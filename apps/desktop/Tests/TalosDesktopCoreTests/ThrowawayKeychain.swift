import Foundation
import Security
import Testing
@testable import TalosDesktopCore
import TalosTestSupport

/// A file keychain made for one test under the test temp folder, and the rules that keep it from ever putting a dialog on the
/// owner's screen. A keychain made with `SecKeychainCreate` keeps the system defaults: it locks after five minutes idle and when the
/// Mac sleeps, and a read from a locked keychain (or of an item whose access list does not trust this process) asks the owner, in a
/// window, for its password. So every throwaway keychain here:
/// - never locks on its own (no idle interval, no lock on sleep), and is unlocked with its own password right after it is made and
///   again before each step that reads it from outside this process (`security`);
/// - lives in a folder named `talos-test-keychain-<uuid>`, so a run that is killed leaves something a later run can recognise and
///   remove (`sweepLeftovers`, once per test process, for folders over an hour old);
/// - is used only inside the `.keychainPromptsOff` scope, which switches Keychain user interaction off for this process, so anything
///   that would still ask fails with `errSecInteractionNotAllowed` instead.
struct ThrowawayKeychain {
  /// The folder prefix this file makes. The older prefixes are what earlier versions of these tests made; the sweep knows them too.
  static let prefix = "talos-test-keychain-"
  static let olderPrefixes = ["talos-signer-", "talos-list-", "talos-seal-"]
  /// A test password for a keychain that holds only test data and is deleted after; not a secret.
  static let password = "talos-test-keychain"

  let keychain: SecKeychain
  let path: String
  let dir: URL

  /// Makes, configures and unlocks a keychain named `name`. Throws (the test fails) when any step does, before anything reads it.
  static func make(_ name: String, under base: URL = TestTemp.url) throws -> ThrowawayKeychain {
    _ = sweepOnce
    let dir = base.appendingPathComponent(prefix + UUID().uuidString)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let path = dir.appendingPathComponent("\(name).keychain-db").path
    var made: SecKeychain?
    let created = SecKeychainCreate(path, UInt32(password.utf8.count), password, false, nil, &made)
    guard created == errSecSuccess, let kc = made else {
      try? FileManager.default.removeItem(at: dir)
      throw KeychainSetupError("SecKeychainCreate: \(created)")
    }
    let k = ThrowawayKeychain(keychain: kc, path: path, dir: dir)
    do {
      try k.neverAutoLock()
      try k.unlock()
    } catch {
      k.remove()
      throw error
    }
    return k
  }

  /// No idle lock and no lock on sleep.
  func neverAutoLock() throws {
    var s = SecKeychainSettings(
      version: UInt32(SEC_KEYCHAIN_SETTINGS_VERS1), lockOnSleep: false, useLockInterval: false, lockInterval: UInt32(INT32_MAX))
    let st = SecKeychainSetSettings(keychain, &s)
    guard st == errSecSuccess else { throw KeychainSetupError("SecKeychainSetSettings: \(st)") }
  }

  /// Unlocks with the known password (never a prompt: the password is passed in).
  func unlock() throws {
    let st = SecKeychainUnlock(keychain, UInt32(Self.password.utf8.count), Self.password, true)
    guard st == errSecSuccess else { throw KeychainSetupError("SecKeychainUnlock: \(st)") }
  }

  var settings: SecKeychainSettings? {
    var s = SecKeychainSettings(version: UInt32(SEC_KEYCHAIN_SETTINGS_VERS1), lockOnSleep: true, useLockInterval: true, lockInterval: 0)
    return SecKeychainCopySettings(keychain, &s) == errSecSuccess ? s : nil
  }

  var isUnlocked: Bool {
    var status: SecKeychainStatus = 0
    guard SecKeychainGetStatus(keychain, &status) == errSecSuccess else { return false }
    return status & SecKeychainStatus(kSecUnlockStateStatus) != 0
  }

  func remove() {
    SecKeychainDelete(keychain)
    try? FileManager.default.removeItem(at: dir)
  }

  /// Runs Apple's `security` tool against this keychain (unlocked first: the tool is another process, and this process's
  /// interaction setting does not reach it). Answers its exit status.
  func security(_ args: [String]) throws -> Int32 {
    try unlock()
    let tool = Process()
    tool.executableURL = URL(fileURLWithPath: "/usr/bin/security")
    tool.arguments = args + [path]
    tool.standardOutput = FileHandle.nullDevice
    tool.standardError = FileHandle.nullDevice
    try tool.run()
    tool.waitUntilExit()
    return tool.terminationStatus
  }

  /// The once-per-process sweep (a `static let` runs its initialiser once, thread-safely).
  static let sweepOnce: Void = { _ = sweepLeftovers() }()

  /// Removes test keychain folders under `base` older than `age`: the keychain file is deleted through the Keychain (so it leaves
  /// any search list it was on), then the folder. Only folders with one of this file's prefixes that hold a `.keychain-db` are
  /// touched. Answers the folders it removed.
  @discardableResult
  static func sweepLeftovers(under base: URL = TestTemp.url, olderThan age: TimeInterval = 3600, now: Date = Date()) -> [String] {
    let fm = FileManager.default
    guard let names = try? fm.contentsOfDirectory(atPath: base.path) else { return [] }
    var removed: [String] = []
    for name in names where ([prefix] + olderPrefixes).contains(where: { name.hasPrefix($0) }) {
      let dir = base.appendingPathComponent(name)
      guard let attrs = try? fm.attributesOfItem(atPath: dir.path), attrs[.type] as? FileAttributeType == .typeDirectory,
        let changed = attrs[.modificationDate] as? Date, now.timeIntervalSince(changed) > age,
        let files = try? fm.contentsOfDirectory(atPath: dir.path)
      else { continue }
      let keychains = files.filter { $0.hasSuffix(".keychain-db") }
      guard !keychains.isEmpty else { continue }
      for file in keychains {
        var kc: SecKeychain?
        if SecKeychainOpen(dir.appendingPathComponent(file).path, &kc) == errSecSuccess, let kc { SecKeychainDelete(kc) }
      }
      if (try? fm.removeItem(at: dir)) != nil { removed.append(name) }
    }
    return removed
  }
}

struct KeychainSetupError: Error, CustomStringConvertible {
  let description: String
  init(_ d: String) { description = d }
}

/// Keychain user interaction off for this process for the whole test (or every test of a suite), through the same counted switch the
/// app's Keychain calls use, so an overlapping call ending cannot turn it back on mid-test. A read that would ask the owner fails
/// with `errSecInteractionNotAllowed` instead.
struct KeychainPromptsOff: SuiteTrait, TestTrait, TestScoping {
  var isRecursive: Bool { true }

  func provideScope(for test: Test, testCase: Test.Case?, performing function: @Sendable () async throws -> Void) async throws {
    _ = ThrowawayKeychain.sweepOnce
    KeychainQuiet.enter()
    defer { KeychainQuiet.leave() }
    try await function()
  }
}

extension Trait where Self == KeychainPromptsOff {
  static var keychainPromptsOff: Self { KeychainPromptsOff() }
}
