import Testing

@testable import TalosSupervisor

/// The setup's one bar follows `CloneProvisioner`'s steps: forward only, inside 0...100, and a finished step ends where the next begins.
@Suite("Provision progress")
struct ProvisionProgressTests {
  @Test func everyStepHasAShareAndTheBarOnlyMovesForward() {
    var last = 0
    for step in CloneProvisioner.Step.allCases {
      let start = ProvisionProgress.percent(step: step, state: .running)
      let end = ProvisionProgress.percent(step: step, state: .done)
      #expect(start >= last, "\(step) starts behind where the last one ended")
      #expect(end >= start && end <= 100)
      last = end
    }
    #expect(last <= ProvisionProgress.agentFolder.0)  // the agent's own folder comes after the download
    #expect(ProvisionProgress.agentFolder.1 <= ProvisionProgress.extras.0)
    #expect(ProvisionProgress.extras.1 == 100)
  }

  @Test func aWaitingStepHoldsItsStartAndAFailedOneNeverJumps() {
    #expect(ProvisionProgress.percent(step: .developerTools, state: .waiting("x")) == 0)
    #expect(ProvisionProgress.percent(step: .clone, state: .failed("x")) == ProvisionProgress.percent(step: .clone, state: .running))
  }
}
