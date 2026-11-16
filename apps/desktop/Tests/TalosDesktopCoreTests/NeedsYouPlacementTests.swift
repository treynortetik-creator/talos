import CoreGraphics
import Testing
@testable import TalosDesktopCore

@Suite("Where the Needs-you popups stand")
struct NeedsYouPlacementTests {
  let area = CGRect(x: 0, y: 25, width: 1440, height: 875)

  @Test func mainsPopupIsCentredOnTheScreen() {
    let o = NeedsYouPlacement.origins(panels: [(isMain: true, size: CGSize(width: 400, height: 200))], area: area)
    #expect(o == [CGPoint(x: 520, y: 362.5)])
  }

  @Test func aThreadsPopupsStayTopRightAndMainsDoesNotTakeASlot() {
    let o = NeedsYouPlacement.origins(
      panels: [
        (isMain: false, size: CGSize(width: 400, height: 200)), (isMain: true, size: CGSize(width: 400, height: 200)),
        (isMain: false, size: CGSize(width: 400, height: 100)),
      ], area: area)
    #expect(o[0] == CGPoint(x: 1440 - 400 - 16, y: 900 - 16 - 200))
    #expect(o[1] == CGPoint(x: 520, y: 362.5))
    #expect(o[2] == CGPoint(x: 1440 - 400 - 16, y: 900 - 16 - 200 - 12 - 100), "the second thread popup stacks under the first")
  }
}
