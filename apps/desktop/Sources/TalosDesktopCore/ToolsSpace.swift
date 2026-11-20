import Foundation

/// Free space needed before Talos asks macOS to install Apple's Command Line Tools (`xcode-select --install`, never full Xcode).
///
/// The number is what macOS 26's own installer demanded on a clean test Mac (2026-11-20): "Can't install the software because there is not
/// enough disk space. 19.18 GB is needed but only 19.16 GB is available." Apple documents no figure for this
/// (Apple's "Installing the command line tools" page in the Xcode documentation says nothing about space) and the tools themselves
/// are a few GB installed, so the installer is reserving headroom well above their size; 20 GB (decimal, as macOS counts) clears what it asked.
/// Unverified beyond that one observation: if Apple's figure is found to be lower, lower this one constant.
public enum ToolsSpace {
  public static let requiredBytes: Int64 = 20_000_000_000
  /// Opens System Settings at General > Storage.
  public static let storageSettingsURL = "x-apple.systempreferences:com.apple.settings.Storage"

  /// The free space to report when it is too little, nil when it is enough or could not be read (an unreadable figure never blocks).
  public static func shortfall(available: Int64?, required: Int64 = requiredBytes) -> Int64? {
    guard let available, available < required else { return nil }
    return available
  }

  /// "about 20" for the need, one decimal below it for what is free ("19.2"): rounded DOWN so a Mac a hair short never reads as enough.
  public static func gb(_ bytes: Int64) -> String {
    let tenths = max(0, bytes) / 100_000_000
    return tenths % 10 == 0 ? String(tenths / 10) : "\(tenths / 10).\(tenths % 10)"
  }

  /// Free space on the volume holding `home`, the way macOS counts it for the owner's own use (purgeable space included, as the
  /// installer's check does). nil when it can't be read.
  public static func availableBytes(home: String) -> Int64? {
    let values = try? URL(fileURLWithPath: home).resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
    return values?.volumeAvailableCapacityForImportantUsage
  }
}

extension OnboardingFlow.Tools {
  public var isNeedSpace: Bool { if case .needSpace = self { return true } else { return false } }
}
