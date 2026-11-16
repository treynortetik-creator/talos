import Capacitor
import PhotosUI
import UIKit
import UniformTypeIdentifiers

/// The + menu's three choices in the iPhone app (apps/web/src/features/composer): `pickPhotos`, `takePhoto` and `pickFiles`.
/// Each opens ONE native picker straight from the tap (no web file input, so iOS never adds its own Photo Library / Take Photo /
/// Choose File sheet) and resolves `{ files: [{ name, mime, base64 }] }`; the page turns them into File objects and attaches them
/// as it does for an input. A dismissed picker resolves `{ files: [] }`. No camera (a simulator) rejects with code "no-camera".
/// Nothing is sent from here. The photo picker needs no permission (it runs out of process); the camera uses the existing
/// NSCameraUsageDescription.
@objc(TalosPickerPlugin)
public class TalosPickerPlugin: CAPPlugin, CAPBridgedPlugin, PHPickerViewControllerDelegate,
    UIImagePickerControllerDelegate, UINavigationControllerDelegate, UIDocumentPickerDelegate
{
    public let identifier = "TalosPickerPlugin"
    public let jsName = "TalosPicker"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "pickPhotos", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "takePhoto", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pickFiles", returnType: CAPPluginReturnPromise),
    ]

    /// The call a picker on screen will answer. One at a time; a second call while one is open is refused.
    private var pending: CAPPluginCall?
    /// Bigger than this and the file is refused by name rather than sent through the bridge as base64.
    private static let maxBytes = 64 * 1024 * 1024

    @objc func pickPhotos(_ call: CAPPluginCall) {
        present(call) {
            var config = PHPickerConfiguration(photoLibrary: .shared())
            config.filter = .images // what the composer's photo input accepted (image/*)
            config.selectionLimit = 0 // any number
            let picker = PHPickerViewController(configuration: config)
            picker.delegate = self
            return picker
        }
    }

    @objc func takePhoto(_ call: CAPPluginCall) {
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
            return call.reject("This device has no camera.", "no-camera")
        }
        present(call) {
            let picker = UIImagePickerController()
            picker.sourceType = .camera
            picker.mediaTypes = [UTType.image.identifier]
            picker.delegate = self
            return picker
        }
    }

    @objc func pickFiles(_ call: CAPPluginCall) {
        present(call) {
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
            picker.allowsMultipleSelection = true
            picker.delegate = self
            return picker
        }
    }

    private func present(_ call: CAPPluginCall, _ make: @escaping () -> UIViewController) {
        guard TalosPluginGate.allows(bridge) else { return call.reject("not allowed here") }
        DispatchQueue.main.async { [weak self] in
            guard let self, let host = self.bridge?.viewController else { return call.reject("no view") }
            guard self.pending == nil else { return call.reject("a picker is already open") }
            self.pending = call
            host.present(make(), animated: true)
        }
    }

    private func finish(_ files: [[String: String]]) {
        let call = pending
        pending = nil
        call?.resolve(["files": files])
    }

    private func fail(_ message: String) {
        let call = pending
        pending = nil
        call?.reject(message)
    }

    private static func mime(forName name: String) -> String {
        UTType(filenameExtension: (name as NSString).pathExtension)?.preferredMIMEType ?? "application/octet-stream"
    }

    private static func entry(name: String, mime: String, data: Data) -> [String: String] {
        ["name": name, "mime": mime, "base64": data.base64EncodedString()]
    }

    // MARK: photo library

    public func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard !results.isEmpty else { return finish([]) }
        var files = [[String: String]?](repeating: nil, count: results.count)
        var failure: String?
        let group = DispatchGroup()
        let lock = NSLock()
        for (i, result) in results.enumerated() {
            let provider = result.itemProvider
            group.enter()
            provider.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { data, _ in
                defer { group.leave() }
                lock.lock()
                defer { lock.unlock() }
                guard let data else { failure = "could not read a photo"; return }
                guard data.count <= Self.maxBytes else { failure = "a photo is too large to attach"; return }
                // JPEG, PNG and GIF go as they are; anything else (HEIC) goes as a JPEG so every viewer can show it.
                let stem = provider.suggestedName ?? "photo-\(i + 1)"
                let kept: [(UTType, String)] = [(.jpeg, "jpg"), (.png, "png"), (.gif, "gif")]
                let type = provider.registeredTypeIdentifiers.compactMap { UTType($0) }
                    .first { t in kept.contains { t.conforms(to: $0.0) } }
                if let type, let ext = kept.first(where: { type.conforms(to: $0.0) })?.1 {
                    files[i] = Self.entry(name: "\(stem).\(ext)", mime: type.preferredMIMEType ?? "image/\(ext)", data: data)
                } else if let image = UIImage(data: data), let jpeg = image.jpegData(compressionQuality: 0.9) {
                    files[i] = Self.entry(name: "\(stem).jpg", mime: "image/jpeg", data: jpeg)
                } else {
                    failure = "could not read a photo"
                }
            }
        }
        group.notify(queue: .main) { [weak self] in
            if let failure { self?.fail(failure) } else { self?.finish(files.compactMap { $0 }) }
        }
    }

    // MARK: camera

    public func imagePickerController(
        _ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
    ) {
        picker.dismiss(animated: true)
        guard let image = info[.originalImage] as? UIImage, let jpeg = image.jpegData(compressionQuality: 0.9) else {
            return fail("could not read the photo")
        }
        let stamp = Int(Date().timeIntervalSince1970)
        finish([Self.entry(name: "photo-\(stamp).jpg", mime: "image/jpeg", data: jpeg)])
    }

    public func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        picker.dismiss(animated: true)
        finish([])
    }

    // MARK: files

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        var files: [[String: String]] = []
        for url in urls {
            // asCopy: the file is already a private copy in the app's temp folder; it is deleted once read.
            defer { try? FileManager.default.removeItem(at: url) }
            let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            guard size <= Self.maxBytes else { return fail("\(url.lastPathComponent) is too large to attach") }
            guard let data = try? Data(contentsOf: url) else { return fail("could not read \(url.lastPathComponent)") }
            files.append(Self.entry(name: url.lastPathComponent, mime: Self.mime(forName: url.lastPathComponent), data: data))
        }
        finish(files)
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        finish([])
    }
}
