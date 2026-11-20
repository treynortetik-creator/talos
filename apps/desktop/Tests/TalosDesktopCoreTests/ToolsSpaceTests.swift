import Foundation
import Testing

@testable import TalosDesktopCore

@Suite("Space before Apple's install")
struct ToolsSpaceTests {
  @Test func theVmCaseIsShortAndNamesWhatIsFree() {
    // the clean-VM run: 19.16 GB free was refused by Apple
    #expect(ToolsSpace.shortfall(available: 19_160_000_000) == 19_160_000_000)
    #expect(ToolsSpace.shortfall(available: 0) == 0)
  }

  @Test func enoughOrUnreadableNeverBlocks() {
    #expect(ToolsSpace.shortfall(available: ToolsSpace.requiredBytes) == nil)
    #expect(ToolsSpace.shortfall(available: 80_000_000_000) == nil)
    #expect(ToolsSpace.shortfall(available: nil) == nil)  // a figure that can't be read is not a refusal
  }

  @Test func theRequirementIsTwentyGbAndStorageOpensTheRightPane() {
    #expect(ToolsSpace.requiredBytes == 20_000_000_000)
    #expect(ToolsSpace.storageSettingsURL == "x-apple.systempreferences:com.apple.settings.Storage")
    #expect(URL(string: ToolsSpace.storageSettingsURL) != nil)
  }

  @Test func gigabytesRoundDownSoAHairShortNeverReadsAsEnough() {
    #expect(ToolsSpace.gb(20_000_000_000) == "20")
    #expect(ToolsSpace.gb(19_160_000_000) == "19.1")
    #expect(ToolsSpace.gb(19_999_999_999) == "19.9")
    #expect(ToolsSpace.gb(0) == "0")
  }

  @Test func theRealVolumeAnswers() {
    let n = ToolsSpace.availableBytes(home: NSTemporaryDirectory())
    #expect((n ?? 0) > 0)
    #expect(ToolsSpace.availableBytes(home: "/nonexistent-talos-path") == nil)
  }

  @Test func theScreenStateAndItsWords() {
    var f = OnboardingFlow()
    // before the download runs, a late message changes nothing
    f.apply(.toolsNeedSpace(have: 1))
    #expect(f.tools == .asking && f.step == .welcome)
    f.apply(.getStarted)
    f.apply(.toolsNeedSpace(have: 19_160_000_000))
    #expect(f.step == .appleTools && f.tools == .needSpace(have: 19_160_000_000))
    #expect(OnboardingCopy.spaceBody(have: 19_160_000_000) == "Talos needs about 20 GB free on this Mac to install Apple's tools. You have 19.1 GB free.")
    f.apply(.toolsAsked)  // room found: Apple's own window is next
    #expect(f.tools == .asking)
  }

  @Test func theNewWordsAreInTheCopyGuardAndPlain() {
    for w in [OnboardingCopy.spaceTitle, OnboardingCopy.spaceBody(have: 19_160_000_000), OnboardingCopy.spaceHow, OnboardingCopy.spaceFooter] {
      #expect(OnboardingCopy.all.contains(w), Comment(rawValue: w))
      #expect(OnboardingCopy.forbiddenWords(in: w).isEmpty, Comment(rawValue: w))
    }
  }
}
