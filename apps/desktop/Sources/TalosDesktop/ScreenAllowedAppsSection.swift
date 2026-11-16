import SwiftUI
import TalosDesktopCore

/// Settings → Permissions → "Apps your agent may control": the apps the owner let agents see and drive on this Mac (screen helper
/// lane 3), each with Remove. Adding happens only from the owner's card on the phone; this section only shows and takes away.
struct ScreenAllowedAppsSection: View {
  @State private var model: ScreenAllowedAppsModel?
  @State private var tick = 0

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      let _ = tick
      HStack {
        Text(ScreenAllowedAppsModel.title).font(.headline)
        Spacer()
        Button("Refresh list") {
          load()
          tick += 1
        }
      }
      Text(ScreenAllowedAppsModel.explainer).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      Text(ScreenAllowedAppsModel.knownGap).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      if let m = model {
        ForEach(m.notes, id: \.self) { n in
          Text(n).font(.caption).foregroundStyle(m.unreadable ? Color.orange : Color.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        if m.unreadable {
          Button("Start a new list") {
            m.startNewList()
            tick += 1
          }
        }
        if let e = m.error {
          Text(e).font(.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("screen-apps-error")
        }
        ForEach(m.rows) { row in
          HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 1) {
              Text(row.name)
              Text([row.bundleID, row.signedBy, row.added].filter { !$0.isEmpty }.joined(separator: " · ")).font(.caption)
                .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            Button("Remove") {
              m.remove(row.bundleID)
              tick += 1
            }
            .accessibilityLabel("Remove \(row.name)")
          }
          .accessibilityElement(children: .combine)
        }
      } else {
        Text("Screen control runs only in the installed Talos app.").font(.caption).foregroundStyle(.secondary)
      }
    }
    .onAppear { load() }
  }

  private func load() {
    guard let store = ScreenHelperHost.shared.store else {
      model = nil
      return
    }
    if let m = model, m.store === store { m.refresh() } else { model = ScreenAllowedAppsModel(store: store) }
  }
}
