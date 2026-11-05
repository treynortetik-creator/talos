import Foundation
import Testing

@testable import TalosShareCore

@Suite("StoredShareToken")
struct StoredShareTokenTests {
    @Test func roundTripsAndKeepsScopes() throws {
        let data = try #require(StoredShareToken.encode(secret: goodSecret, scopes: ["text", "files"]))
        let t = try #require(StoredShareToken.decode(data))
        #expect(t.scopes == [.text, .files])
        let textData = try #require(StoredShareToken.encode(secret: goodSecret, scopes: ["text"]))
        let textOnly = try #require(StoredShareToken.decode(textData))
        #expect(textOnly.scopes == [.text])
    }

    @Test func filesImpliesText() throws {
        let data = try #require(StoredShareToken.encode(secret: goodSecret, scopes: ["files"]))
        let t = try #require(StoredShareToken.decode(data))
        #expect(t.scopes == [.text, .files])
    }

    @Test func refusesBadInputOnTheWayIn() {
        #expect(StoredShareToken.encode(secret: "talos_share_short", scopes: ["text"]) == nil)
        #expect(StoredShareToken.encode(secret: goodSecret, scopes: []) == nil)
        #expect(StoredShareToken.encode(secret: goodSecret, scopes: ["admin"]) == nil)
        #expect(StoredShareToken.encode(secret: goodSecret, scopes: ["text", "files", "text"]) == nil)
        #expect(StoredShareToken.encode(secret: goodSecret + "\r\nX: 1", scopes: ["text"]) == nil)
    }

    @Test func refusesTamperedBytesOnTheWayOut() {
        #expect(StoredShareToken.decode(Data("not json".utf8)) == nil)
        #expect(StoredShareToken.decode(Data(#"{"v":2,"secret":"\#(goodSecret)","scopes":["text"]}"#.utf8)) == nil)
        #expect(StoredShareToken.decode(Data(#"{"v":1,"secret":"x","scopes":["text"]}"#.utf8)) == nil)
        #expect(StoredShareToken.decode(Data(#"{"v":1,"secret":"\#(goodSecret)","scopes":["root"]}"#.utf8)) == nil)
        #expect(StoredShareToken.decode(Data()) == nil)
    }
}
