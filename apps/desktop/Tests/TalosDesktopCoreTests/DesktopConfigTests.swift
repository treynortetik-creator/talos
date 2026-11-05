import Testing
@testable import TalosDesktopCore

@Suite("DesktopConfig")
struct DesktopConfigTests {
  @Test func defaultsRoundTripThroughJSON() throws {
    let data = try DesktopConfig.defaults.encoded()
    let back = try DesktopConfig.decode(data)
    #expect(back == DesktopConfig.defaults)
  }

  @Test func defaultsAreGenericAndSafe() {
    let c = DesktopConfig.defaults
    #expect(c.v == 1)
    #expect(c.agentDir == "~/talos-agent")
    #expect(c.relayUrl == "https://relay.example.com")
    #expect(c.autoRestart)
    #expect(c.autoConfirmRestart)
    #expect(c.args.allSatisfy { !$0.contains("/Users/") })
  }

  @Test func usesSnakeCaseKeysLikeTheSpec() throws {
    let text = String(decoding: try DesktopConfig.defaults.encoded(), as: UTF8.self)
    let obj = try #require(jsonObject(text))
    for key in ["agent_dir", "claude_path", "auto_restart", "auto_confirm_restart", "relay_url"] {
      #expect(obj[key] != nil, "missing key \(key)")
    }
  }
}
