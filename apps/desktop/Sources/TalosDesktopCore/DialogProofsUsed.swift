import CryptoKit
import Foundation

/// `workers/<id>/dialog-proofs-used.json`: the signed taps the Mac has already acted on, whatever came of them, each as `key`. A dialog
/// that is still on the pane keeps its id when the app relaunches, so a list kept in memory only would let a copy of a tap that pressed
/// nothing (the owner was typing, an arrow did not show) press after a relaunch. The Mac writes and reads this file; nothing else does.
/// A file that is missing or does not fit reads as an empty list.
public enum DialogProofsUsed {
  public static let fileName = "dialog-proofs-used.json"
  /// Main's own list, beside its own answer file in the default thread's folder: apart from a worker's on the same thread.
  public static let mainFileName = "main-dialog-proofs-used.json"
  /// The newest this many are kept: a proof is only good for 15 minutes anyway.
  public static let keep = 64

  /// One tap: the dialog and the exact text the owner's device signed (it carries the tap's own id and time). Not the signature's text: the
  /// same signature can be spelled more than one way, and a copy spelled differently must still be the same tap.
  public static func key(dialogId: String, proof: DialogProof) -> String {
    dialogId + "|" + SHA256.hash(data: Data(proof.signed.utf8)).map { String(format: "%02x", $0) }.joined()
  }

  public static func read(path: String) -> [String] {
    guard case .data(let d) = SmallFile.read(path: path, maxBytes: 64 * 1024),
      let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any], JSONValue.int(o["v"]) == 1, let used = o["used"] as? [String]
    else { return [] }
    return used
  }

  /// Whether a tap is used: in this process's own list, or in the file.
  public static func contains(_ key: String, memory: [String], path: String) -> Bool {
    memory.contains(key) || read(path: path).contains(key)
  }

  /// Records a tap that checked out, before anything is pressed for it: the list to keep in memory, and whether the file was written. A
  /// tap that could not be written must press nothing, or a copy of it could press after a relaunch. `folderIsReal` is asked right before
  /// the write (the folder is not a link): when it says no, nothing is written and the memory list still takes the tap.
  /// The memory list is the caller's and is the authority: `record` never fills it from the file, so entries a session wrote into the
  /// file (anything running as the owner can) cannot push a real tap out of it. A caller may seed it once from the file at launch (the
  /// restart requests do; the dialog answers do not): seeded entries are its oldest and are evicted first. The file keeps the memory list first, and what it held
  /// from before only in the room left, so a relaunch still sees the taps of the last run.
  public static func record(
    _ key: String, memory: [String], path: String, folderIsReal: () -> Bool
  ) -> (memory: [String], written: Bool) {
    let mine = Array(dedup(memory + [key]).suffix(keep))
    let room = keep - mine.count
    let before = room > 0 ? Array(dedup(read(path: path).filter { !mine.contains($0) }).suffix(room)) : []
    guard folderIsReal() else { return (mine, false) }
    return (mine, (try? AtomicFile.write(encode(before + mine), to: path, mode: 0o600)) != nil)
  }

  private static func dedup(_ list: [String]) -> [String] {
    var out: [String] = []
    for u in list where !out.contains(u) { out.append(u) }
    return out
  }

  public static func encode(_ used: [String]) -> Data {
    (try? JSONSerialization.data(withJSONObject: ["v": 1, "used": Array(used.suffix(keep))], options: [.sortedKeys])) ?? Data()
  }
}
