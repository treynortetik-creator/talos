// The release key for the Mac app's signed manifest (packages/protocol/src/release-manifest.ts): ECDSA P-256 in this Mac's Secure
// Enclave. Run with `swift apps/desktop/scripts/release-key.swift <command>`.
//
//   create --out <path> [--software]   a new key: Secure Enclave, default flags (no user presence, no biometry, so a scheduled or
//                                      background session can sign); its blob written to <path> (0600, refused if it exists). Prints
//                                      the kid and the pin line for RELEASE_KEYS / ReleaseTrust.keys. --software makes a plain
//                                      software key instead: TESTS ONLY, it can be copied off the Mac.
//   pub --key <path>                   the kid and the pin line again
//   sign --key <path> <file> [--allow-software]
//                                      the signature over "talos-release-manifest/v1\n" + the file's exact bytes: raw r || s, 64
//                                      bytes, low-S, base64, one line. A software key signs only with --allow-software (tests).
//
// The key file is JSON {"v":1,"type":"se"|"software","key":"<base64>"}: for "se" the Enclave's wrapped blob (useless on any other
// Mac), for "software" the raw private scalar. Nothing here prints a private key. The blob lives outside the repo
// (~/.config/talos/release-key/<kid>.se by convention) and outside every backup. If this Mac is lost, the key is gone: each beta Mac
// then needs one reinstall by hand with a new pinned key.
// Exit codes: 0 done; 1 a step failed (it says which); 64 bad arguments.
import CryptoKit
import Foundation

let domain = Data("talos-release-manifest/v1\n".utf8)
let halfN: [UInt8] = [
  0x7f, 0xff, 0xff, 0xff, 0x80, 0x00, 0x00, 0x00, 0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  0xde, 0x73, 0x7d, 0x56, 0xd3, 0x8b, 0xcf, 0x42, 0x79, 0xdc, 0xe5, 0x61, 0x7e, 0x31, 0x92, 0xa8,
]
let n: [UInt8] = [
  0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  0xbc, 0xe6, 0xfa, 0xad, 0xa7, 0x17, 0x9e, 0x84, 0xf3, 0xb9, 0xca, 0xc2, 0xfc, 0x63, 0x25, 0x51,
]

func die(_ s: String, _ code: Int32 = 1) -> Never {
  FileHandle.standardError.write(Data("release-key: \(s)\n".utf8))
  exit(code)
}

/// s replaced by n - s when s > n / 2: the one form both verifiers accept.
func lowS(_ raw: Data) -> Data {
  let s = Array(raw.suffix(32))
  var high = false
  for (a, b) in zip(s, halfN) where a != b {
    high = a > b
    break
  }
  guard high else { return raw }
  var out = [UInt8](repeating: 0, count: 32)
  var borrow = 0
  for i in stride(from: 31, through: 0, by: -1) {
    var d = Int(n[i]) - Int(s[i]) - borrow
    borrow = d < 0 ? 1 : 0
    if d < 0 { d += 256 }
    out[i] = UInt8(d)
  }
  return raw.prefix(32) + Data(out)
}

func pin(_ pub: P256.Signing.PublicKey) -> (kid: String, line: String) {
  let raw = pub.x963Representation
  let kid = String(SHA256.hash(data: raw).map { String(format: "%02x", $0) }.joined().prefix(16))
  return (kid, "{ kid: '\(kid)', publicKey: '\(raw.base64EncodedString())' }")
}

enum Key {
  case enclave(SecureEnclave.P256.Signing.PrivateKey)
  case software(P256.Signing.PrivateKey)
  var publicKey: P256.Signing.PublicKey {
    switch self {
    case .enclave(let k): return k.publicKey
    case .software(let k): return k.publicKey
    }
  }
  func sign(_ d: Data) throws -> Data {
    switch self {
    case .enclave(let k): return try k.signature(for: d).rawRepresentation
    case .software(let k): return try k.signature(for: d).rawRepresentation
    }
  }
}

func load(_ path: String) -> Key {
  guard let d = FileManager.default.contents(atPath: path), let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
    (o["v"] as? Int) == 1, let type = o["type"] as? String, let b = (o["key"] as? String).flatMap({ Data(base64Encoded: $0) })
  else { die("\(path) is not a release key file") }
  do {
    switch type {
    case "se": return .enclave(try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: b))
    case "software": return .software(try P256.Signing.PrivateKey(rawRepresentation: b))
    default: die("\(path) holds a key of an unknown type")
    }
  } catch {
    die("\(path) could not be loaded (a Secure Enclave key works only on the Mac that made it): \(error)")
  }
}

func value(_ args: [String], _ flag: String) -> String? {
  guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
  return args[i + 1]
}

let args = Array(CommandLine.arguments.dropFirst())
switch args.first {
case "create":
  guard let out = value(args, "--out") else { die("create needs --out <path>", 64) }
  guard !FileManager.default.fileExists(atPath: out) else { die("\(out) exists; a key is never written over", 64) }
  let software = args.contains("--software")
  let type: String
  let blob: Data
  let pub: P256.Signing.PublicKey
  do {
    if software {
      let k = P256.Signing.PrivateKey()
      (type, blob, pub) = ("software", k.rawRepresentation, k.publicKey)
    } else {
      guard SecureEnclave.isAvailable else { die("this Mac has no Secure Enclave") }
      // default flags: no user presence and no biometry, so a background session can sign
      let k = try SecureEnclave.P256.Signing.PrivateKey()
      (type, blob, pub) = ("se", k.dataRepresentation, k.publicKey)
    }
  } catch {
    die("could not create the key: \(error)")
  }
  let file = try! JSONSerialization.data(withJSONObject: ["v": 1, "type": type, "key": blob.base64EncodedString()], options: [.sortedKeys])
  let dir = (out as NSString).deletingLastPathComponent
  try? FileManager.default.createDirectory(atPath: dir.isEmpty ? "." : dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
  guard FileManager.default.createFile(atPath: out, contents: file, attributes: [.posixPermissions: 0o600]) else { die("could not write \(out)") }
  let p = pin(pub)
  print("kid \(p.kid)")
  print("pin \(p.line)")
case "pub":
  guard let path = value(args, "--key") else { die("pub needs --key <path>", 64) }
  let p = pin(load(path).publicKey)
  print("kid \(p.kid)")
  print("pin \(p.line)")
case "sign":
  // the one argument that is not the command, a flag or the key's path
  var rest: [String] = []
  var i = 1
  while i < args.count {
    if args[i] == "--key" { i += 2; continue }
    if !args[i].hasPrefix("--") { rest.append(args[i]) }
    i += 1
  }
  guard let path = value(args, "--key"), rest.count == 1, let file = rest.first else {
    die("usage: sign --key <path> <file> [--allow-software]", 64)
  }
  let key = load(path)
  if case .software = key, !args.contains("--allow-software") { die("a software key signs only with --allow-software (tests)") }
  guard let bytes = FileManager.default.contents(atPath: file) else { die("\(file) cannot be read") }
  do {
    let raw = lowS(try key.sign(domain + bytes))
    print(raw.base64EncodedString())
  } catch {
    die("signing failed: \(error)")
  }
default:
  die("usage: release-key.swift create --out <path> [--software] | pub --key <path> | sign --key <path> <file>", 64)
}
