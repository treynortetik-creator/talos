import XCTest
@testable import BridgeGuard

/// Capacitor's own cookie and HTTP plugins are never reachable from a page: the web app does not use them, and getCookies
/// reads the app-wide cookie jar for any URL, which would carry one relay's cookies to another relay's page.
final class BlockedPluginTests: XCTestCase {
    func testCookieAndHttpPluginsAreBlocked() {
        for id in ["CapacitorCookies", "CapacitorHttp"] {
            XCTAssertTrue(BridgeGuard.blocksPluginCall(body: ["pluginId": id, "methodName": "getCookies", "options": ["url": "https://a.example.test"]]), id)
        }
    }

    func testTheAppsOwnPluginsAreNotBlocked() {
        for id in ["TalosShare", "TalosPush", "TalosRelay", "Haptics", "Keyboard"] {
            XCTAssertFalse(BridgeGuard.blocksPluginCall(body: ["pluginId": id, "methodName": "x"]), id)
        }
    }

    func testAMessageThatNamesNoPluginIsBlockedNotWavedThrough() {
        XCTAssertTrue(BridgeGuard.blocksPluginCall(body: ["methodName": "getCookies"]))
        XCTAssertTrue(BridgeGuard.blocksPluginCall(body: "not a dictionary"))
        XCTAssertTrue(BridgeGuard.blocksPluginCall(body: ["pluginId": 7]))
        XCTAssertTrue(BridgeGuard.blocksPluginCall(body: ["pluginId": ""]))
    }

    func testTheNameIsExactNotACaseOrPrefixMatch() {
        // A different spelling is a different (unregistered) plugin; the block list is for the two real ones.
        XCTAssertFalse(BridgeGuard.blocksPluginCall(body: ["pluginId": "capacitorcookies2"]))
    }

    // MARK: The prompt() channel

    func testThePromptChannelNeverCarriesCookieOrHttpCalls() {
        for prompt in ["CapacitorCookies.set", "CapacitorCookies.get", "CapacitorCookies.clear", "CapacitorHttp.request",
                       " CapacitorCookies.set", "capacitorcookies.set", "CAPACITORHTTP.get"] {
            XCTAssertTrue(BridgeGuard.blocksPrompt(prompt), prompt)
        }
    }

    func testOtherPromptsAreNotBlockedHere() {
        for prompt in ["", "hello", "Please type your name", "TalosShare.x"] {
            XCTAssertFalse(BridgeGuard.blocksPrompt(prompt), prompt)
        }
    }

    /// The exact strings Capacitor 8.5.3's native-bridge.js sends: `prompt(JSON.stringify(payload))`, at its lines 383, 404, 426 and 456
    /// (apps/mobile/test/runtime-origin.test.ts checks that this list is still every payload type in that file).
    private let capacitorPrompts = [
        #"{"type":"CapacitorCookies.isEnabled"}"#,
        #"{"type":"CapacitorCookies.get"}"#,
        #"{"type":"CapacitorCookies.set","action":"session=abc; path=/","domain":""}"#,
        #"{"type":"CapacitorHttp"}"#,
    ]

    func testTheRealCapacitorCookieAndHttpPromptsAreBlocked() {
        for prompt in capacitorPrompts { XCTAssertTrue(BridgeGuard.blocksPrompt(prompt), prompt) }
    }

    func testTheJSONTypeIsTrimmedAndCaseInsensitiveAndKeysMayComeInAnyOrder() {
        for prompt in [#"{"action":"x","type":" capacitorcookies.set"}"#, #"  {"type":"CAPACITORHTTP"}  "#,
                       #"{"domain":"","type":"CapacitorCookies.get\n"}"#] {
            XCTAssertTrue(BridgeGuard.blocksPrompt(prompt), prompt)
        }
    }

    func testAPromptShapedLikeTheChannelThatCannotBeReadIsBlocked() {
        // Capacitor's handler would not dispatch these either; a page gains nothing by sending them.
        for prompt in ["{", #"{"type":"#, #"{"type":7}"#, #"{"action":"CapacitorCookies.set"}"#, #"{"type":null}"#, "{curly words}"] {
            XCTAssertTrue(BridgeGuard.blocksPrompt(prompt), prompt)
        }
    }

    func testOrdinaryPromptsAndOtherJSONTypesPass() {
        for prompt in [#"{"type":"TalosThing"}"#, "What is your name?", ""] {
            XCTAssertFalse(BridgeGuard.blocksPrompt(prompt), prompt)
        }
    }
}
