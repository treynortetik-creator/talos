import CoreGraphics
import Foundation
import ImageIO

/// A captured image as PNG bytes, scaled down (never up) so its long edge is at most `maxLongEdge` pixels.
public enum ScreenPNG {
  public static let largestMaxLongEdge = 16_384

  public static func encode(_ image: CGImage, maxLongEdge: Int) throws(ScreenRefusal) -> (data: Data, width: Int, height: Int) {
    guard (1...largestMaxLongEdge).contains(maxLongEdge) else {
      throw .badRequest("the longest side is set to \(maxLongEdge) pixels; it must be 1 to \(largestMaxLongEdge)")
    }
    let (w, h) = scaledSize(width: image.width, height: image.height, maxLongEdge: maxLongEdge)
    guard w > 0, h > 0 else { throw .encodeFailed("the image is empty") }
    let out: CGImage
    if w == image.width && h == image.height {
      out = image
    } else {
      guard let space = CGColorSpace(name: CGColorSpace.sRGB),
        let ctx = CGContext(
          data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: space,
          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
      else { throw .encodeFailed("no drawing context for \(w)×\(h)") }
      ctx.interpolationQuality = .high
      ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
      guard let scaled = ctx.makeImage() else { throw .encodeFailed("scaling to \(w)×\(h) failed") }
      out = scaled
    }
    let data = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(data as CFMutableData, "public.png" as CFString, 1, nil) else {
      throw .encodeFailed("no PNG encoder")
    }
    CGImageDestinationAddImage(dest, out, nil)
    guard CGImageDestinationFinalize(dest) else { throw .encodeFailed("the PNG encoder failed") }
    return (data as Data, w, h)
  }

  /// The size after the downscale: the long edge at most `maxLongEdge`, the aspect kept, each side at least 1.
  static func scaledSize(width: Int, height: Int, maxLongEdge: Int) -> (Int, Int) {
    let long = max(width, height)
    guard width > 0, height > 0, long > maxLongEdge else { return (width, height) }
    let s = Double(maxLongEdge) / Double(long)
    return (max(1, Int((Double(width) * s).rounded())), max(1, Int((Double(height) * s).rounded())))
  }
}
