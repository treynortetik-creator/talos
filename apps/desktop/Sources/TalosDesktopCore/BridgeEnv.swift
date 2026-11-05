import Foundation

/// The two variables the agent must start with for the Talos bridge to reach it (`docs/SETUP.md`: `TALOS_APP_BRIDGE=1
/// MCP_PROTOCOL_NEGOTIATION=legacy claude …`). Importing a launch command used to replace `env` with whatever the pasted
/// line carried, so a line without them started an agent the bridge could never reach (audit D45).
public enum BridgeEnv {
  public static let required: [String: String] = ["TALOS_APP_BRIDGE": "1", "MCP_PROTOCOL_NEGOTIATION": "legacy"]

  /// The imported variables with the required ones on top.
  public static func merged(_ imported: [String: String]) -> [String: String] {
    imported.merging(required) { _, req in req }
  }
}
