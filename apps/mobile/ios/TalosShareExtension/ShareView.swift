import SwiftUI

struct ShareView: View {
    @ObservedObject var model: ShareModel

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                switch model.phase {
                case .loading:
                    ProgressView().frame(maxWidth: .infinity)
                case .ready, .sending, .failed:
                    preview
                    TextField("Note for \(model.agentLabel) (optional)", text: $model.note, axis: .vertical)
                        .lineLimit(1...4)
                        .textFieldStyle(.roundedBorder)
                        .disabled(model.phase == .sending)
                    if case .failed(let message) = model.phase {
                        Text(message).font(.callout).foregroundStyle(.red).accessibilityIdentifier("share-error")
                    }
                case .sent:
                    Label("Sent to \(model.agentLabel)", systemImage: "checkmark.circle.fill")
                        .font(.headline).foregroundStyle(.green).frame(maxWidth: .infinity)
                        .accessibilityIdentifier("share-sent")
                case .blocked(let message):
                    Text(message).font(.body).accessibilityIdentifier("share-blocked")
                }
                Spacer(minLength: 0)
            }
            .padding()
            .navigationTitle("Talos")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { model.onClose() } }
                ToolbarItem(placement: .confirmationAction) {
                    switch model.phase {
                    case .ready, .failed: Button("Send") { model.send() }.bold()
                    case .sending: ProgressView()
                    default: EmptyView()
                    }
                }
            }
        }
    }

    private var preview: some View {
        Text(model.summary)
            .font(.callout)
            .lineLimit(6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
            .accessibilityIdentifier("share-preview")
    }
}
