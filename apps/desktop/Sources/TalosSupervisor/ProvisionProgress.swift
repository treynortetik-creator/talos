import Foundation

/// Where the setup's one progress bar stands for each step of `CloneProvisioner`. The steps do not take equal time (the download and
/// the packages are most of it), so each has its own share. The bar only ever moves forward: `percent` of a step that has begun is the
/// share that step started at, and a finished step's share is where the next begins.
public enum ProvisionProgress {
  /// (starts at, ends at), in percent. The agent's own folder and the scheduler follow the provisioner: `agentFolder`, `extras`.
  static let shares: [CloneProvisioner.Step: (Int, Int)] = [
    .developerTools: (0, 6), .lookup: (6, 10), .clone: (10, 40), .verify: (40, 44), .claude: (44, 62), .prerequisites: (62, 68),
    .dependencies: (68, 86), .record: (86, 88),
  ]
  public static let agentFolder = (88, 96)
  public static let extras = (96, 100)

  public static func percent(step: CloneProvisioner.Step, state: CloneProvisioner.State) -> Int {
    guard let s = shares[step] else { return 0 }
    switch state {
    case .done: return s.1
    default: return s.0
    }
  }
}
