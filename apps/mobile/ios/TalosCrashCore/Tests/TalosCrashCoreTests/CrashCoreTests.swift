import Foundation
import XCTest
@testable import TalosCrashCore

final class CrashCoreTests: XCTestCase {
    private func fixture(_ name: String) throws -> Data {
        let url = try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
        return try Data(contentsOf: url)
    }

    func testPayloadBecomesTheExpectedSummaries() throws {
        let got = CrashCore.summaries(fromPayloadJSON: try fixture("diagnostic-payload"))
        let want = try JSONDecoder().decode([CrashSummary].self, from: try fixture("expected-summaries"))
        XCTAssertEqual(got, want)
    }

    func testOneUnknownEntryCostsThatEntryOnly() throws {
        // the fixture holds a string where an object belongs, an unknown exception number, a tree that is a string, and an
        // unknown top-level group: three reports still come out
        XCTAssertEqual(CrashCore.summaries(fromPayloadJSON: try fixture("diagnostic-payload")).count, 3)
    }

    func testNotJSONGivesNothingAndDoesNotCrash() {
        XCTAssertEqual(CrashCore.summaries(fromPayloadJSON: Data("not json".utf8)), [])
        XCTAssertEqual(CrashCore.summaries(fromPayloadJSON: Data("[1,2,3]".utf8)), [])
        XCTAssertEqual(CrashCore.summaries(fromPayloadJSON: Data()), [])
    }

    func testFramesAreCappedAndTheReasonIsCutShort() {
        var frame = #"{"binaryName":"Talos","offsetIntoBinaryTextSegment":1}"#
        for _ in 0..<100 { frame = #"{"binaryName":"Talos","offsetIntoBinaryTextSegment":1,"subFrames":[\#(frame)]}"# }
        let long = String(repeating: "x", count: 500)
        let json = #"{"crashDiagnostics":[{"diagnosticMetaData":{"terminationReason":"\#(long)"},"callStackTree":{"callStacks":[{"callStackRootFrames":[\#(frame)]}]}}]}"#
        let s = CrashCore.summaries(fromPayloadJSON: Data(json.utf8))
        XCTAssertEqual(s.count, 1)
        XCTAssertEqual(s[0].frames.count, CrashCore.maxFrames)
        XCTAssertEqual(s[0].reason.count, 120)
    }

    func testWaitingListKeepsTheNewest() {
        let one = CrashSummary(kind: "crash", name: "a", reason: "", appVersion: "", appBuild: "", frames: [])
        var waiting: [CrashSummary] = []
        for i in 0..<30 {
            var s = one
            s.name = "n\(i)"
            waiting = CrashCore.appending([s], to: waiting)
        }
        XCTAssertEqual(waiting.count, CrashCore.maxWaiting)
        XCTAssertEqual(waiting.first?.name, "n10")
        XCTAssertEqual(waiting.last?.name, "n29")
    }
}
