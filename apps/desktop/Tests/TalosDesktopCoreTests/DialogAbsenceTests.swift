import Testing
@testable import TalosDesktopCore

/// When a held needs-you flag may go: no dialog shape on the pane for `settle` running, on a fake clock.
struct DialogAbsenceTests {
  @Test func presentIsNeverGone() {
    var a = DialogAbsence()
    let g0 = a.gone(present: true, at: 0, settle: 5)
    #expect(!g0)
    let g100 = a.gone(present: true, at: 100, settle: 5)
    #expect(!g100)
  }

  @Test func absentForLessThanTheSettleIsNotGone() {
    var a = DialogAbsence()
    let g10 = a.gone(present: false, at: 10, settle: 5)
    #expect(!g10)
    let g14_9 = a.gone(present: false, at: 14.9, settle: 5)
    #expect(!g14_9)
  }

  @Test func absentForTheSettleIsGone() {
    var a = DialogAbsence()
    let g10 = a.gone(present: false, at: 10, settle: 5)
    #expect(!g10)
    let g15 = a.gone(present: false, at: 15, settle: 5)
    #expect(g15)
    let g20 = a.gone(present: false, at: 20, settle: 5)
    #expect(g20)
  }

  @Test func theShapeBackStartsOver() {
    var a = DialogAbsence()
    let g10 = a.gone(present: false, at: 10, settle: 5)
    #expect(!g10)
    let g13 = a.gone(present: true, at: 13, settle: 5)
    #expect(!g13)
    let g14 = a.gone(present: false, at: 14, settle: 5)
    #expect(!g14)
    let g18_9 = a.gone(present: false, at: 18.9, settle: 5)
    #expect(!g18_9)
    let g19 = a.gone(present: false, at: 19, settle: 5)
    #expect(g19)
  }

  @Test func resetForgetsTheAbsence() {
    var a = DialogAbsence()
    let g0 = a.gone(present: false, at: 0, settle: 5)
    #expect(!g0)
    a.reset()
    let g5 = a.gone(present: false, at: 5, settle: 5)
    #expect(!g5)
  }
}
