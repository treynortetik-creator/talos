import Foundation
import Security
import TalosDesktopCore

/// The app's side of `WorkerHook.BundleSource`: the hook the bundle carries (`Contents/Resources/talos-hooks/permission-relay.py`)
/// and the real check of the bundle's code signature. Here and not in the core, which is Foundation only.
extension WorkerHook {
  /// The running app's own hook, made once: its signature check is asked once per run and the answer kept.
  public static let appSource = source(in: .main)

  /// The hook inside `bundle`. A bundle without one gives a source that refuses every start and says why.
  public static func source(
    in bundle: Bundle, seal: @escaping @Sendable (String) -> String? = { WorkerHook.sealProblem(bundlePath: $0, isThisProcess: true) }
  ) -> BundleSource {
    let script = bundle.url(forResource: "permission-relay", withExtension: "py", subdirectory: bundleFolder)?.path
    return BundleSource(script: script, bundlePath: bundle.bundlePath, seal: seal)
  }

  /// Why the bundle at `bundlePath` fails its code signature check, or nil when it passes. Two things are asked:
  ///  - the bundle on disk is valid: the seal over its code and every resource, all architectures, the strict rules build-app.sh
  ///    holds it to. An unsigned bundle fails, and so does one with a file edited, added or removed since it was signed.
  ///  - `isThisProcess`: the bundle on disk is the app that is running, by its code directory hash (which covers the resource
  ///    seal). A valid signature alone says only that somebody signed what is there: a bundle whose hook was edited and that was
  ///    then signed again, ad hoc or with any identity, is valid, and is not this app. Asked of the running process, whose hash
  ///    the kernel holds, so nothing on disk can answer for it.
  ///
  /// The answer is asked once per run and kept (`BundleSource`), so an app replaced on disk while it runs is not checked again by
  /// this run: its hook files are then no longer the ones this run checked, every start is refused ("changed after the app's
  /// signature was checked"), and the line says to quit and reopen Talos. Nothing here relaunches the app by itself; scripts/install.sh
  /// quits the running app before it swaps the bundle, so an update made that way never meets this.
  public static func sealProblem(bundlePath: String, isThisProcess: Bool) -> String? {
    var made: SecStaticCode?
    let status = SecStaticCodeCreateWithPath(URL(fileURLWithPath: bundlePath) as CFURL, [], &made)
    guard status == errSecSuccess, let code = made else { return describe(status) }
    let flags = SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSStrictValidate)
    let valid = SecStaticCodeCheckValidity(code, flags, nil)
    guard valid == errSecSuccess else { return describe(valid) }
    guard isThisProcess else { return nil }
    var info: CFDictionary?
    let read = SecCodeCopySigningInformation(code, [], &info)
    guard read == errSecSuccess, let hash = (info as? [String: Any])?[kSecCodeInfoUnique as String] as? Data, !hash.isEmpty else {
      return "the app on disk has no code hash to compare with the app that is running, \(describe(read))"
    }
    let hex = hash.map { String(format: "%02x", $0) }.joined()
    var requirement: SecRequirement?
    var me: SecCode?
    guard SecRequirementCreateWithString("cdhash H\"\(hex)\"" as CFString, [], &requirement) == errSecSuccess, let requirement,
      SecCodeCopySelf([], &me) == errSecSuccess, let me
    else { return "the app that is running could not be compared with the app on disk" }
    let same = SecCodeCheckValidity(me, [], requirement)
    return same == errSecSuccess ? nil : "the app on disk is not the app that is running, \(describe(same))"
  }

  private static func describe(_ status: OSStatus) -> String {
    let text = SecCopyErrorMessageString(status, nil) as String?
    return text.map { "\($0), \(status)" } ?? "error \(status)"
  }
}
