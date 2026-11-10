import CryptoKit
import Foundation
import Testing
@testable import TalosDesktopCore

/// The seal on `confirmed_launch`: an HMAC with a key that is not in desktop.json. Pure: the in-memory store; the real Keychain has its own
/// opt-in suite (KeychainLaunchTrustTests).
private func config(confirmed: String? = nil) -> DesktopConfig {
  var c = DesktopConfig.defaults
  c.confirmedLaunch = confirmed
  return c
}

@Suite("Launch trust: the seal")
struct LaunchTrustTests {
  private let parts = ["folder": "aaaaaaaaaaaaaaaa", "program": "bbbbbbbbbbbbbbbb", "flags": "cccccccccccccccc", "env": "dddddddddddddddd"]

  @Test func aConfirmedLaunchIsTrustedWhileItsMacVerifies() {
    let trust = MemoryLaunchTrust()
    var c = config()
    #expect(LaunchSeal.confirm(&c, fingerprint: "f1", parts: parts, trust: trust))
    #expect(c.confirmedLaunch == "f1" && c.confirmedLaunchMac?.count == 64 && c.confirmedLaunchParts == parts)
    #expect(LaunchSeal.isConfirmed(c, fingerprint: "f1", parts: parts, trust: trust))
    #expect(!LaunchSeal.isConfirmed(c, fingerprint: "f2", parts: parts, trust: trust), "another launch is not the confirmed one")
  }

  /// The stored description must be this launch's own: sealed parts that differ from the current ones are a changed launch.
  @Test func thePartsMustBeThisLaunchsToo() {
    let trust = MemoryLaunchTrust()
    var c = config()
    LaunchSeal.confirm(&c, fingerprint: "f1", parts: parts, trust: trust)
    var other = parts
    other["env"] = "eeeeeeeeeeeeeeee"
    #expect(!LaunchSeal.isConfirmed(c, fingerprint: "f1", parts: other, trust: trust))
    #expect(!LaunchSeal.isConfirmed(c, fingerprint: "f1", parts: [:], trust: trust))
  }

  // MARK: the fingerprint

  /// SHA-256 over a length-prefixed encoding: a value that contains the old separator and a look-alike next field is not the next field.
  @Test func theFingerprintIsASha256AndUnambiguous() {
    var a = DesktopConfig.defaults
    var b = DesktopConfig.defaults
    a.args = ["--x", "a\u{0}arg=b"]
    b.args = ["--x", "a", "b"]
    #expect(a.launchFingerprint(resolvedClaude: "/c") != b.launchFingerprint(resolvedClaude: "/c"))
    a = .defaults
    b = .defaults
    a.env = ["K": "v\u{0}env=L=w"]
    b.env = ["K": "v", "L": "w"]
    #expect(a.launchFingerprint(resolvedClaude: "/c") != b.launchFingerprint(resolvedClaude: "/c"))
    a = .defaults
    b = .defaults
    a.args = ["ab", "c"]
    b.args = ["a", "bc"]
    #expect(a.launchFingerprint(resolvedClaude: "/c") != b.launchFingerprint(resolvedClaude: "/c"), "where one value ends is part of the encoding")
    a = .defaults
    b = .defaults
    a.args = ["12:ab"]
    b.args = ["1", "2:ab"]
    #expect(a.launchFingerprint(resolvedClaude: "/c") != b.launchFingerprint(resolvedClaude: "/c"), "lengths are part of the encoding")
    let fp = DesktopConfig.defaults.launchFingerprint(resolvedClaude: "/c")
    #expect(fp.count == 64 && fp.allSatisfy { "0123456789abcdef".contains($0) }, "\(fp)")
    #expect(DesktopConfig.defaults.launchFingerprint(resolvedClaude: "/c") == fp)
    #expect(DesktopConfig.defaults.launchFingerprint(resolvedClaude: "/d") != fp)
  }

  /// A seal made with the old FNV fingerprint (version 1) is cleared by the migration, and refused even if the file is restored by hand.
  @Test func anOldFormatSealIsRefusedAfterTheMigration() {
    let trust = MemoryLaunchTrust()
    var c = config()
    let old = "00000000deadbeef"  // the old 16-hex FNV shape
    LaunchSeal.confirm(&c, fingerprint: old, parts: parts, trust: trust)
    c.launchTrust = 1
    #expect(LaunchTrustMigration.run(&c))
    #expect(c.confirmedLaunch == nil && c.confirmedLaunchMac == nil && c.confirmedLaunchParts == nil && c.launchTrust == LaunchTrustMigration.version)
    #expect(LaunchTrustMigration.version >= 2)
    let now = DesktopConfig.defaults.launchFingerprint(resolvedClaude: "/c")
    #expect(!LaunchSeal.isConfirmed(c, fingerprint: now, parts: parts, trust: trust))
  }

  @Test func aFingerprintWrittenIntoTheFileWithoutAMacIsNotTrusted() {
    var c = config(confirmed: "f1")
    #expect(!LaunchSeal.isConfirmed(c, fingerprint: "f1", parts: parts, trust: MemoryLaunchTrust()))
    c.confirmedLaunchMac = String(repeating: "0", count: 64)
    let trust = MemoryLaunchTrust()
    _ = trust.mac("x", createKey: true)
    #expect(!LaunchSeal.isConfirmed(c, fingerprint: "f1", parts: parts, trust: trust), "a MAC that does not verify")
  }

  @Test func editingTheFingerprintOrThePartsBreaksTheSeal() {
    let trust = MemoryLaunchTrust()
    var c = config()
    LaunchSeal.confirm(&c, fingerprint: "f1", parts: parts, trust: trust)
    var edited = c
    edited.confirmedLaunch = "f2"
    #expect(!LaunchSeal.isConfirmed(edited, fingerprint: "f2", parts: parts, trust: trust), "an agent rewrote the fingerprint and kept the MAC")
    edited = c
    edited.confirmedLaunchParts?["env"] = "eeeeeeeeeeeeeeee"
    #expect(!LaunchSeal.isConfirmed(edited, fingerprint: "f1", parts: parts, trust: trust), "the description is sealed too")
    edited = c
    edited.confirmedLaunchParts = nil
    #expect(!LaunchSeal.isConfirmed(edited, fingerprint: "f1", parts: parts, trust: trust))
  }

  @Test func aMissingKeyFailsClosedAndTheOwnersConfirmMakesOne() {
    let trust = MemoryLaunchTrust()
    var c = config()
    LaunchSeal.confirm(&c, fingerprint: "f1", parts: parts, trust: trust)
    trust.dropKey()
    #expect(!LaunchSeal.isConfirmed(c, fingerprint: "f1", parts: parts, trust: trust), "no key: not confirmed")
    #expect(trust.mac("anything", createKey: false) == nil, "a verify path never makes a key")
    #expect(!trust.hasKey)
    LaunchSeal.confirm(&c, fingerprint: "f1", parts: parts, trust: trust)
    #expect(trust.hasKey && LaunchSeal.isConfirmed(c, fingerprint: "f1", parts: parts, trust: trust))
  }

  @Test func aStoreThatCannotBeUsedFailsClosedAndStoresTheFingerprintUnsealed() {
    let trust = MemoryLaunchTrust()
    trust.available = false
    var c = config()
    #expect(!LaunchSeal.confirm(&c, fingerprint: "f1", parts: parts, trust: trust))
    #expect(c.confirmedLaunch == "f1" && c.confirmedLaunchMac == nil)
    #expect(!LaunchSeal.isConfirmed(c, fingerprint: "f1", parts: parts, trust: trust))
    trust.available = true
    #expect(!LaunchSeal.isConfirmed(c, fingerprint: "f1", parts: parts, trust: trust), "unsealed stays unsealed until the owner confirms again")
  }

  @Test func theMacIsAnHmacSha256UnderTheStoredKeyAndNothingElseVerifies() {
    let key = SymmetricKey(size: .bits256)
    let trust = MemoryLaunchTrust(key: key)
    let m = LaunchSeal.message(fingerprint: "f1", parts: parts)
    let mac = trust.mac(m, createKey: false)
    #expect(mac == LaunchSeal.hmac(m, key: key))
    #expect(mac.map { trust.verify(m, mac: $0) } == true)
    #expect(MemoryLaunchTrust(key: SymmetricKey(size: .bits256)).verify(m, mac: mac ?? "") == false, "another key")
    for bad in ["", "zz", String(repeating: "A", count: 64), String(repeating: "g", count: 64), (mac ?? "") + "0", String((mac ?? "").dropLast())] {
      #expect(!trust.verify(m, mac: bad), "\(bad)")
    }
  }

  @Test func theSealedMessageNamesTheVersionAndSortsTheParts() {
    #expect(LaunchSeal.message(fingerprint: "f1", parts: ["b": "2", "a": "1"]) == "talos-launch-seal/v1\nf1\na=1\nb=2")
    #expect(LaunchSeal.message(fingerprint: "f1", parts: nil) == "talos-launch-seal/v1\nf1")
  }

  // MARK: the migration

  @Test func theMigrationClearsAnUnsealedValueOnceAndIsQuietAfterwards() {
    var c = config(confirmed: "old")
    c.confirmedLaunchParts = parts
    #expect(LaunchTrustMigration.run(&c))
    #expect(c.confirmedLaunch == nil && c.confirmedLaunchParts == nil && c.launchTrust == LaunchTrustMigration.version)
    #expect(!LaunchTrustMigration.run(&c), "a second run does nothing")
  }

  @Test func theMigrationKeepsAValueSealedInTheCurrentFormat() {
    var c = config()
    LaunchSeal.confirm(&c, fingerprint: "f1", parts: parts, trust: MemoryLaunchTrust())
    c.launchTrust = LaunchTrustMigration.version
    #expect(!LaunchTrustMigration.run(&c))
    #expect(c.confirmedLaunch == "f1" && c.confirmedLaunchMac != nil)
  }

  @Test func theMigrationRunsAgainWhenTheVersionIsResetAndLoadSavesOnlyWhenItRan() throws {
    let dir = NSTemporaryDirectory() + "talos-trust-\(UUID().uuidString.prefix(8))"
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(atPath: dir) }
    let path = dir + "/desktop.json"
    #expect(LaunchTrustMigration.load(path).config == nil && !FileManager.default.fileExists(atPath: path), "no file: nothing is made")
    var c = config(confirmed: "old")
    try ConfigFile.save(c, to: path)
    let first = LaunchTrustMigration.load(path)
    #expect(first.migrated && first.config?.confirmedLaunch == nil)
    #expect(try ConfigFile.load(path)?.launchTrust == LaunchTrustMigration.version && (try ConfigFile.load(path))?.confirmedLaunch == nil)
    #expect(!LaunchTrustMigration.load(path).migrated)
    c = try #require(try ConfigFile.load(path))
    c.confirmedLaunch = "agent-wrote-this"
    c.launchTrust = 0
    try ConfigFile.save(c, to: path)
    #expect(LaunchTrustMigration.load(path).migrated, "launch_trust back to 0 runs it again")
    #expect(try ConfigFile.load(path)?.confirmedLaunch == nil)
  }

  // MARK: desktop.json

  @Test func theSealRoundTripsAndBadTypesCostOnlyThatValue() throws {
    var c = config()
    LaunchSeal.confirm(&c, fingerprint: "f1", parts: parts, trust: MemoryLaunchTrust())
    c.launchTrust = LaunchTrustMigration.version
    let back = try DesktopConfig.decode(try c.encoded())
    #expect(back.confirmedLaunch == "f1" && back.confirmedLaunchMac == c.confirmedLaunchMac && back.confirmedLaunchParts == parts && back.launchTrust == LaunchTrustMigration.version)
    let text = String(decoding: try c.encoded(), as: UTF8.self)
    #expect(text.contains("\"confirmed_launch_mac\"") && text.contains("\"confirmed_launch_parts\"") && text.contains("\"launch_trust\""))
    var o = try #require(JSONSerialization.jsonObject(with: try c.encoded()) as? [String: Any])
    o["confirmed_launch_mac"] = 7
    o["launch_trust"] = "x"
    o["confirmed_launch_parts"] = ["env": 1]
    let odd = try DesktopConfig.decode(try JSONSerialization.data(withJSONObject: o))
    #expect(odd.confirmedLaunchMac == nil && odd.launchTrust == nil && odd.confirmedLaunchParts == nil && odd.confirmedLaunch == "f1")
  }

  @Test func theChangedPiecesAreNamedInTheCardsOrderAndNeverQuoted() {
    let was = ["folder": "1", "program": "2", "flags": "3", "env": "4"]
    #expect(DesktopConfig.changedPieces(confirmed: was, now: was) == [])
    #expect(DesktopConfig.changedPieces(confirmed: was, now: ["folder": "1", "program": "9", "flags": "3", "env": "8"]) == ["program", "env"])
    #expect(DesktopConfig.changedPieces(confirmed: nil, now: was) == [])
    var c = DesktopConfig.defaults
    c.env = ["SECRET": "hunter2"]
    #expect(!c.launchParts(resolvedClaude: "/x/claude").values.joined().contains("hunter2"))
    #expect(c.launchParts(resolvedClaude: "/x/claude")["env"] != DesktopConfig.defaults.launchParts(resolvedClaude: "/x/claude")["env"])
  }
}

/// The real Keychain, opt-in: `TALOS_KEYCHAIN_TESTS=1 swift test --filter KeychainLaunchTrustTests`. Only a throwaway item under a service name this
/// test makes up is touched (and deleted); prompts are switched off, so a read the Keychain would ask about fails instead.
@Suite("Launch trust: the real Keychain", .enabled(if: ProcessInfo.processInfo.environment["TALOS_KEYCHAIN_TESTS"] == "1"))
struct KeychainLaunchTrustTests {
  @Test func aKeyIsMadeOnTheOwnersConfirmAndSealsAndVerifies() {
    let store = KeychainLaunchTrust(service: "com.talos.test.launch-seal.\(UUID().uuidString.lowercased())", account: "test")
    defer { #expect(store.deleteKey(), "the throwaway item is gone") }
    #expect(store.mac("m", createKey: false) == nil, "no key yet: a verify path makes none")
    #expect(!store.verify("m", mac: String(repeating: "0", count: 64)))
    let mac = store.mac("m", createKey: true)
    #expect(mac?.count == 64)
    #expect(store.mac("m", createKey: false) == mac, "the same key the second time")
    #expect(mac.map { store.verify("m", mac: $0) } == true)
    #expect(mac.map { store.verify("other", mac: $0) } == false)
  }
}
