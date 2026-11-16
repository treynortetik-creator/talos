import Foundation
import Security
import Testing
@testable import TalosDesktopCore
import TalosTestSupport

/// No Keychain test may put a dialog on the owner's screen, even when its throwaway keychain is locked (idle timeout, sleep) or a
/// killed run left one behind. Every read below that could ask first checks that prompts are off, and records a failure instead of
/// reading when they are not: a broken guard turns this suite red, never into a dialog.
@Suite("Keychain: a test keychain never asks the owner", .serialized, .keychainPromptsOff)
struct KeychainNoPromptTests {
  /// Fails the test (and answers false) when Keychain prompts are on in this process: the read that follows would ask.
  static func promptsAreOff(_ where_: String) -> Bool {
    guard KeychainQuiet.promptsOff else {
      Issue.record("Keychain prompts are ON before \(where_): refusing to read (it would put a dialog on the screen)")
      return false
    }
    return true
  }

  /// What a read that would have asked answers with prompts off: macOS says "interaction not allowed" or, for a locked file
  /// keychain, "authorization failed" (seen on macOS 26). Never success, never "not found" (a caller would make a new key over it).
  static func refusedWithoutAsking(_ st: OSStatus) -> Bool {
    st == errSecInteractionNotAllowed || st == errSecAuthFailed
  }

  @Test func theWholeTestRunsWithPromptsOff() {
    #expect(KeychainQuiet.promptsOff, "the suite's scope switched Keychain interaction off for the whole test")
  }

  @Test func aThrowawayKeychainNeverLocksOnItsOwnAndStartsUnlocked() throws {
    let k = try ThrowawayKeychain.make("settings")
    defer { k.remove() }
    let s = try #require(k.settings)
    #expect(!s.lockOnSleep.boolValue, "a Mac that sleeps mid-test does not lock it")
    // macOS reads "no timeout" back as the largest interval (the flag itself can read back as set)
    #expect(!s.useLockInterval.boolValue || s.lockInterval == UInt32(INT32_MAX), "no idle timeout locks it (interval \(s.lockInterval))")
    #expect(k.isUnlocked)
    #expect(k.dir.lastPathComponent.hasPrefix(ThrowawayKeychain.prefix))
  }

  /// The proof: a locked keychain, then the very reads the launch-seal and screen-list tests do. Each fails at once
  /// (`refusedWithoutAsking`); none waits on a password dialog. Control: unlocked, the same item reads.
  @Test func aLockedThrowawayKeychainFailsTheReadInsteadOfAsking() throws {
    let k = try ThrowawayKeychain.make("locked")
    defer { k.remove() }
    let service = "com.talos.test.launch-seal.\(UUID().uuidString.lowercased())"
    let item = KeychainItem(service: service, account: "test", keychain: k.keychain)
    let key = Data(repeating: 7, count: 32)
    #expect(item.add(key) == errSecSuccess)
    try #require(SecKeychainLock(k.keychain) == errSecSuccess)
    try #require(!k.isUnlocked, "the keychain is locked for the proof")

    guard Self.promptsAreOff("the raw read") else { return }
    // the raw call, with nothing but this process's interaction setting between it and a dialog (no UI-fail flag)
    var out: CFTypeRef?
    let raw: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "test",
      kSecMatchSearchList as String: [k.keychain], kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    let rawStatus = SecItemCopyMatching(raw as CFDictionary, &out)
    #expect(Self.refusedWithoutAsking(rawStatus), "the raw read failed at once (\(rawStatus))")

    guard Self.promptsAreOff("the item read") else { return }
    let itemStatus = item.read().1
    #expect(Self.refusedWithoutAsking(itemStatus), "the app's own read fails closed (\(itemStatus))")
    let store = KeychainLaunchTrust(service: service, account: "test", keychain: k.keychain, signer: "1111111111111111")
    #expect(store.mac("m", createKey: true) == nil, "the seal cannot be made, and makes no second key, while locked")
    #expect(KeychainItem(service: service, account: "test.signer-1111111111111111", keychain: k.keychain).read().1 != errSecSuccess)
    #expect(!k.isUnlocked, "nothing unlocked it behind the test's back")

    try k.unlock()
    #expect(item.read() == (key, errSecSuccess), "control: unlocked, the same read works")
  }

  /// The read the reported dialog came from: an item whose access list trusts no app (another signer's), read by this process.
  /// With prompts off it fails at once; with them on macOS asks for the keychain's password.
  @Test func anotherSignersItemFailsTheReadInsteadOfAsking() throws {
    let k = try ThrowawayKeychain.make("seal")
    defer { k.remove() }
    let service = "com.talos.test.launch-seal.\(UUID().uuidString.lowercased())"
    let made = try k.security(["add-generic-password", "-s", service, "-a", "test", "-T", "", "-X", String(repeating: "ab", count: 32)])
    try #require(made == 0, "the other signer's item was made")
    guard Self.promptsAreOff("the other signer's item read") else { return }
    var out: CFTypeRef?
    let raw: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "test",
      kSecMatchSearchList as String: [k.keychain], kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    let st = SecItemCopyMatching(raw as CFDictionary, &out)
    #expect(Self.refusedWithoutAsking(st), "unreadable, and said so (\(st))")
  }

  @Test func aKilledRunsKeychainIsSweptOnlyWhenOld() throws {
    let base = TestTemp.url.appendingPathComponent("talos-sweep-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: base) }
    let old = try ThrowawayKeychain.make("old", under: base)
    let fresh = try ThrowawayKeychain.make("fresh", under: base)
    defer { fresh.remove() }
    // an older run's folder name, and a folder with the prefix but no keychain in it (not ours to judge: left alone)
    let legacy = base.appendingPathComponent("talos-signer-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: legacy, withIntermediateDirectories: true)
    try Data().write(to: legacy.appendingPathComponent("seal.keychain-db"))
    let notOurs = base.appendingPathComponent(ThrowawayKeychain.prefix + "empty")
    try FileManager.default.createDirectory(at: notOurs, withIntermediateDirectories: true)
    let twoHoursAgo = Date().addingTimeInterval(-7200)
    for d in [old.dir, legacy, notOurs] {
      try FileManager.default.setAttributes([.modificationDate: twoHoursAgo], ofItemAtPath: d.path)
    }
    let removed = ThrowawayKeychain.sweepLeftovers(under: base)
    #expect(Set(removed) == [old.dir.lastPathComponent, legacy.lastPathComponent])
    #expect(!FileManager.default.fileExists(atPath: old.path))
    #expect(FileManager.default.fileExists(atPath: fresh.path), "a keychain made this hour (maybe another run's) is left alone")
    #expect(FileManager.default.fileExists(atPath: notOurs.path))
  }
}
