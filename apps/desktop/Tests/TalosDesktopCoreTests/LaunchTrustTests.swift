import CryptoKit
import Foundation
import Security
import Testing
@testable import TalosDesktopCore
import TalosTestSupport

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
    let dir = TestTemp.base + "talos-trust-\(UUID().uuidString.prefix(8))"
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
@Suite(
  "Launch trust: the real Keychain", .enabled(if: ProcessInfo.processInfo.environment["TALOS_KEYCHAIN_TESTS"] == "1"), .keychainPromptsOff)
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

/// A program running as the owner against the seal's key, in a throwaway keychain made here (never the login keychain): Apple's `security`
/// tool rewrites the key item's secret with no prompt and keeps the item's access list, so the Talos store then reads a key that program
/// knows. Nothing in a file-based keychain tells the two apart (the access list, creator and label are all the program's to set), and the
/// data-protection keychain needs an entitlement this app's signing (ad hoc, or the local self-signed identity) cannot carry.
@Suite("Launch trust: a key swapped by another program", .keychainPromptsOff)
struct LaunchTrustKeySwapTests {
  private let parts = ["folder": "aaaaaaaaaaaaaaaa", "program": "bbbbbbbbbbbbbbbb", "flags": "cccccccccccccccc", "env": "dddddddddddddddd"]

  @Test func aKeyRewrittenByTheSecurityToolLetsThatProgramSealAChangedLaunch() throws {
    let k = try ThrowawayKeychain.make("swap")
    defer { k.remove() }
    let kc = k.keychain
    let service = "com.talos.test.launch-seal.\(UUID().uuidString.lowercased())"
    let store = KeychainLaunchTrust(service: service, account: "test", keychain: kc)
    var c = DesktopConfig.defaults
    #expect(LaunchSeal.confirm(&c, fingerprint: "f1", parts: parts, trust: store), "the owner's confirm seals with a key the app made")
    #expect(LaunchSeal.isConfirmed(c, fingerprint: "f1", parts: parts, trust: store))

    let known = Data((0..<32).map { UInt8($0) })
    let hex = known.map { String(format: "%02x", $0) }.joined()
    let rewrote = try k.security(["add-generic-password", "-U", "-s", service, "-a", "test", "-X", hex])
    try #require(rewrote == 0, "the security tool rewrote the item")
    #expect(!LaunchSeal.isConfirmed(c, fingerprint: "f1", parts: parts, trust: store), "the owner's own seal no longer verifies")

    var forged = c
    forged.confirmedLaunch = "f2"
    forged.confirmedLaunchMac = LaunchSeal.hmac(LaunchSeal.message(fingerprint: "f2", parts: parts), key: SymmetricKey(data: known))
    // Open: closing this needs the data-protection keychain with an access group, so a build signed by an Apple developer team.
    withKnownIssue("a program running as the owner can rewrite the key and seal a changed launch") {
      #expect(!LaunchSeal.isConfirmed(forged, fingerprint: "f2", parts: parts, trust: store), "a launch sealed by the other program is not confirmed")
    }
  }
}

/// After the app's signer changes (a local build, then the notarized one), the item the old signer made exists and this build may not
/// read it. Played in a throwaway keychain: the old signer's item is made by Apple's `security` tool with an empty list of trusted apps
/// (`-T ""`), so this process (any signer) cannot read it with prompts off, exactly as a build signed by someone else cannot.
@Suite("Launch trust: another signer's key", .serialized, .keychainPromptsOff)
struct LaunchTrustOtherSignerTests {
  static func otherSignersItem(service: String, account: String, keychain k: ThrowawayKeychain) throws {
    let made = try k.security(["add-generic-password", "-s", service, "-a", account, "-T", "", "-X", String(repeating: "ab", count: 32)])
    try #require(made == 0, "the other signer's item was made")
  }

  @Test func aNewSignerKeepsItsOwnKeyAndLeavesTheOldOneAlone() throws {
    let k = try ThrowawayKeychain.make("seal")
    defer { k.remove() }
    let kc = k.keychain
    let service = "com.talos.test.launch-seal.\(UUID().uuidString.lowercased())"
    try Self.otherSignersItem(service: service, account: "test", keychain: k)
    let old = KeychainItem(service: service, account: "test", keychain: kc)
    let (_, oldStatus) = old.read()
    try #require(oldStatus != errSecSuccess && oldStatus != errSecItemNotFound, "the old signer's item is there and unreadable (\(oldStatus))")

    // the new signer: the owner's confirm seals with a key of its own, and every later start of the same signer verifies it
    let store = KeychainLaunchTrust(service: service, account: "test", keychain: kc, signer: "1111111111111111")
    var c = DesktopConfig.defaults
    let parts = ["folder": "aaaaaaaaaaaaaaaa"]
    #expect(LaunchSeal.confirm(&c, fingerprint: "f1", parts: parts, trust: store), "the confirm seals, with no prompt")
    let nextStart = KeychainLaunchTrust(service: service, account: "test", keychain: kc, signer: "1111111111111111")
    #expect(LaunchSeal.isConfirmed(c, fingerprint: "f1", parts: parts, trust: nextStart), "the next start reads the same key: no card again")
    #expect(KeychainItem(service: service, account: "test.signer-1111111111111111", keychain: kc).read().1 == errSecSuccess)
    // the old signer's item is untouched (still there, still unreadable here), and another signer does not see this one's key
    #expect(old.read().1 == oldStatus)
    let third = KeychainLaunchTrust(service: service, account: "test", keychain: kc, signer: "2222222222222222")
    #expect(!LaunchSeal.isConfirmed(c, fingerprint: "f1", parts: parts, trust: third))
    // an ad hoc build (no signer key) makes nothing and verifies nothing: fail closed, as before
    let adHoc = KeychainLaunchTrust(service: service, account: "test", keychain: kc, signer: nil)
    #expect(adHoc.mac("m", createKey: true) == nil)
    #expect(!LaunchSeal.isConfirmed(c, fingerprint: "f1", parts: parts, trust: adHoc))
  }

  @Test func theScreenListRecordMovesToTheNewSignerToo() throws {
    let k = try ThrowawayKeychain.make("list")
    defer { k.remove() }
    let kc = k.keychain
    let service = "com.talos.test.screen-list.\(UUID().uuidString.lowercased())"
    try Self.otherSignersItem(service: service, account: "list", keychain: k)
    let keys = KeychainListKeyStore(service: service, keychain: kc, signer: "1111111111111111")
    guard case .success(let made) = keys.load(account: "list") else {
      Issue.record("the new signer could not make its own record")
      return
    }
    var next = made
    next.generation = 7
    guard case .success = keys.save(next, account: "list") else {
      Issue.record("the new signer could not save its record")
      return
    }
    guard case .success(let again) = KeychainListKeyStore(service: service, keychain: kc, signer: "1111111111111111").load(account: "list")
    else {
      Issue.record("the next start could not read the record")
      return
    }
    #expect(again.generation == 7)
    if case .success = KeychainListKeyStore(service: service, keychain: kc, signer: nil).load(account: "list") {
      Issue.record("an ad hoc build must not read or make a record past an unreadable one")
    }
  }

  @Test func theSignerKeyIsStableAndNoneForAdHoc() {
    let devId = #"identifier "app.talos.desktop" and anchor apple generic and certificate leaf[subject.OU] = "ABCDE12345""#
    #expect(SignerKey.key(requirement: devId) == SignerKey.key(requirement: devId))
    #expect(SignerKey.key(requirement: devId)?.count == 16)
    #expect(SignerKey.key(requirement: devId + " ") != SignerKey.key(requirement: devId))
    #expect(SignerKey.key(requirement: #"cdhash H"0123456789abcdef0123456789abcdef01234567""#) == nil)
  }
}

@Suite("Keychain: prompts stay off while any call is inside")
struct KeychainQuietTests {
  /// Two calls overlapping: the second one ending must not turn prompts back on while the first is still inside (the hang this fixes).
  @Test func anOverlappingCallEndingKeepsPromptsOffForTheOther() {
    KeychainQuiet.enter()
    #expect(KeychainQuiet.promptsOff)
    KeychainQuiet.enter()
    KeychainQuiet.leave()
    #expect(KeychainQuiet.promptsOff, "the inner call ended; the outer one is still inside")
    KeychainQuiet.leave()
  }

  @Test func manyAtOnceAlwaysSeePromptsOff() async {
    let seen = await withTaskGroup(of: Bool.self) { g in
      for _ in 0..<64 {
        g.addTask {
          KeychainQuiet.enter()
          defer { KeychainQuiet.leave() }
          for _ in 0..<50 where !KeychainQuiet.promptsOff { return false }
          return true
        }
      }
      var all = true
      for await ok in g { all = all && ok }
      return all
    }
    #expect(seen)
  }
}
