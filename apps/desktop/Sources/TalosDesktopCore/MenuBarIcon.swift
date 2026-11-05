import Foundation

/// The menu bar's picture of Talos, one per `HealthSummary.Icon`. The files are `Resources/menubar/<asset>-1x.png` and `-2x.png`
/// (made by `assets/mascot/3d/tools/menubar_icons.py`): black with alpha only, drawn at 18 pt as a template image so macOS tints
/// them for light, dark and highlighted bars.
extension HealthSummary.Icon {
  public static let menuBarPoints = 18

  /// File stem of the picture for this state.
  public var menuBarAsset: String {
    switch self {
    case .ok: return "talos-ok"
    case .working: return "talos-working"
    case .needsYou: return "talos-needs-you"
    case .down: return "talos-down"
    case .unknown: return "talos-unknown"
    }
  }

  /// What VoiceOver says for the menu-bar item: the state, since the picture alone says nothing to it.
  public var menuBarLabel: String {
    switch self {
    case .ok: return "Talos is running"
    case .working: return "Talos is working"
    case .needsYou: return "Talos needs you"
    case .down: return "Talos is down"
    case .unknown: return "Talos status unknown"
    }
  }
}
