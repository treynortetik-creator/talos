// Foundation helpers for the swift-testing files. Kept in a file that does NOT import Testing: under the Swift 6.2 Command
// Line Tools a file importing both Foundation and Testing failed on the `_Testing_Foundation` cross-import overlay. The
// Swift 6.4 CLT on the build Mac ships the overlay (OBSERVED 2026-10-30), so D1's test files import both.
import Foundation

func jsonObject(_ text: String) -> [String: Any]? {
  (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any]
}

func envFlag(_ name: String) -> Bool { ProcessInfo.processInfo.environment[name] == "1" }
