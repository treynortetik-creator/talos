import Foundation

extension ConfigFile {
  /// What is at the config path. "No file" and "a file this build cannot read" are different answers: the first is a Mac that is
  /// not set up yet and starts from the defaults; the second is the owner's setup behind a typo, and the defaults must never
  /// stand in for it (a start from them runs the agent in the wrong folder, and a save of them writes over what he had).
  public enum Read: Equatable, Sendable {
    case missing
    case loaded(DesktopConfig)
    /// Something is there and it is not a config this build can decode: not JSON, a value of the wrong kind, an empty file, a
    /// folder, or a file that may not be read.
    case unreadable
  }

  public static func read(_ path: String) -> Read {
    guard let data = FileManager.default.contents(atPath: path) else {
      // `contents` is nil for "nothing there" and for "there, but not readable": only the first is a missing file. `lstat`, so a
      // link that points nowhere counts as something there.
      var st = stat()
      return lstat(path, &st) == 0 ? .unreadable : .missing
    }
    guard let config = try? DesktopConfig.decode(data) else { return .unreadable }
    return .loaded(config)
  }
}
