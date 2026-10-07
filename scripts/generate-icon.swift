import AppKit
import Foundation

private func pngData(for image: NSImage) -> Data? {
    guard let tiff = image.tiffRepresentation,
          let bitmap = NSBitmapImageRep(data: tiff) else {
        return nil
    }
    return bitmap.representation(using: .png, properties: [:])
}

private func write(_ image: NSImage, to path: String) throws {
    guard let data = pngData(for: image) else {
        throw NSError(domain: "CursayIcon", code: 1)
    }
    try data.write(to: URL(fileURLWithPath: path), options: .atomic)
}

private func drawBrandMark(in rect: NSRect, lineWidth: CGFloat, ink: NSColor, accent: NSColor) {
    let points: [NSPoint] = [
        NSPoint(x: rect.minX, y: rect.midY),
        NSPoint(x: rect.minX + rect.width * 0.12, y: rect.midY),
        NSPoint(x: rect.minX + rect.width * 0.19, y: rect.midY + rect.height * 0.23),
        NSPoint(x: rect.minX + rect.width * 0.29, y: rect.midY - rect.height * 0.37),
        NSPoint(x: rect.minX + rect.width * 0.39, y: rect.midY + rect.height * 0.46),
        NSPoint(x: rect.minX + rect.width * 0.50, y: rect.midY - rect.height * 0.48),
        NSPoint(x: rect.minX + rect.width * 0.61, y: rect.midY + rect.height * 0.30),
        NSPoint(x: rect.minX + rect.width * 0.70, y: rect.midY - rect.height * 0.12),
        NSPoint(x: rect.minX + rect.width * 0.79, y: rect.midY),
    ]

    let wave = NSBezierPath()
    wave.move(to: points[0])
    for point in points.dropFirst() {
        wave.line(to: point)
    }
    wave.lineWidth = lineWidth
    wave.lineCapStyle = .round
    wave.lineJoinStyle = .round
    ink.setStroke()
    wave.stroke()

    let caret = NSBezierPath()
    caret.move(to: NSPoint(x: rect.maxX, y: rect.minY))
    caret.line(to: NSPoint(x: rect.maxX, y: rect.maxY))
    caret.lineWidth = lineWidth * 1.08
    caret.lineCapStyle = .round
    accent.setStroke()
    caret.stroke()
}

private func makeAppIcon() -> NSImage {
    let canvas = NSSize(width: 1024, height: 1024)
    let image = NSImage(size: canvas)
    image.lockFocus()

    NSColor.clear.setFill()
    NSBezierPath(rect: NSRect(origin: .zero, size: canvas)).fill()

    let tileRect = NSRect(x: 72, y: 72, width: 880, height: 880)
    let shadow = NSShadow()
    shadow.shadowColor = NSColor(calibratedWhite: 0.08, alpha: 0.24)
    shadow.shadowBlurRadius = 42
    shadow.shadowOffset = NSSize(width: 0, height: -16)
    shadow.set()

    let tile = NSBezierPath(roundedRect: tileRect, xRadius: 214, yRadius: 214)
    NSColor(calibratedRed: 246 / 255, green: 241 / 255, blue: 231 / 255, alpha: 1).setFill()
    tile.fill()

    NSGraphicsContext.current?.saveGraphicsState()
    NSShadow().set()
    NSColor(calibratedWhite: 0.25, alpha: 0.12).setStroke()
    tile.lineWidth = 4
    tile.stroke()

    drawBrandMark(
        in: NSRect(x: 206, y: 352, width: 612, height: 300),
        lineWidth: 37,
        ink: NSColor(calibratedRed: 32 / 255, green: 30 / 255, blue: 26 / 255, alpha: 1),
        accent: NSColor(calibratedRed: 231 / 255, green: 100 / 255, blue: 82 / 255, alpha: 1)
    )
    NSGraphicsContext.current?.restoreGraphicsState()
    image.unlockFocus()
    return image
}

private func makeTrayIcon(size: CGFloat) -> NSImage {
    let image = NSImage(size: NSSize(width: size, height: size))
    image.lockFocus()
    NSColor.clear.setFill()
    NSBezierPath(rect: NSRect(x: 0, y: 0, width: size, height: size)).fill()
    drawBrandMark(
        in: NSRect(x: size * 0.08, y: size * 0.25, width: size * 0.82, height: size * 0.5),
        lineWidth: max(1.15, size * 0.075),
        ink: .black,
        accent: .black
    )
    image.unlockFocus()
    image.isTemplate = true
    return image
}

let arguments = Array(CommandLine.arguments.dropFirst())
let appIconPath = arguments.indices.contains(0) ? arguments[0] : "icon-1024.png"
let trayPath = arguments.indices.contains(1) ? arguments[1] : "tray-template.png"
let trayRetinaPath = arguments.indices.contains(2) ? arguments[2] : "tray-template@2x.png"

do {
    try write(makeAppIcon(), to: appIconPath)
    try write(makeTrayIcon(size: 18), to: trayPath)
    try write(makeTrayIcon(size: 36), to: trayRetinaPath)
} catch {
    fputs("Unable to render Cursay icons.\n", stderr)
    exit(1)
}
