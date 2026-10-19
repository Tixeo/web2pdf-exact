// Analyse indépendante d'un PDF avec PDFKit (le moteur PDF de macOS) :
// taille des pages, texte extrait, liens, signets, métadonnées, et rendu PNG.
// Usage : pdfinfo fichier.pdf [dossier_png] [dpi]
import AppKit
import Foundation
import PDFKit

let args = CommandLine.arguments
guard args.count >= 2, let doc = PDFDocument(url: URL(fileURLWithPath: args[1])) else {
    print("{\"error\": \"PDF illisible\"}")
    exit(1)
}
let outDir: String? = args.count > 2 ? args[2] : nil
let dpi: Double = args.count > 3 ? Double(args[3]) ?? 72 : 72

var pages: [[String: Any]] = []
for i in 0..<doc.pageCount {
    guard let page = doc.page(at: i) else { continue }
    let box = page.bounds(for: .mediaBox)
    var links: [[String: Any]] = []
    for a in page.annotations where a.type == "Link" {
        var l: [String: Any] = ["rect": [a.bounds.minX, a.bounds.minY, a.bounds.width, a.bounds.height]]
        if let u = a.url { l["url"] = u.absoluteString }
        if let act = a.action as? PDFActionURL, let u = act.url { l["url"] = u.absoluteString }
        if let d = a.destination, let p = d.page { l["destPage"] = doc.index(for: p); l["destY"] = d.point.y }
        if let act = a.action as? PDFActionGoTo, let p = act.destination.page {
            l["destPage"] = doc.index(for: p); l["destY"] = act.destination.point.y
        }
        links.append(l)
    }
    var lines: [[Any]] = []
    if let sel = page.selection(for: box) {
        for line in sel.selectionsByLine() {
            let b = line.bounds(for: page)
            lines.append([b.minX, b.minY, b.width, b.height, line.string ?? ""])
        }
    }
    var info: [String: Any] = ["w": box.width, "h": box.height, "text": page.string ?? "", "links": links, "lines": lines]
    if let dir = outDir {
        let scale = dpi / 72.0
        let w = max(1, Int((box.width * scale).rounded())), h = max(1, Int((box.height * scale).rounded()))
        let cs = CGColorSpaceCreateDeviceRGB()
        if let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                               bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) {
            // Fond magenta : toute zone non peinte par le PDF sauterait aux yeux.
            ctx.setFillColor(CGColor(red: 1, green: 0, blue: 1, alpha: 1))
            ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
            ctx.scaleBy(x: scale, y: scale)
            page.draw(with: .mediaBox, to: ctx)
            if let img = ctx.makeImage(), let png = NSBitmapImageRep(cgImage: img).representation(using: .png, properties: [:]) {
                let path = "\(dir)/page-\(i + 1).png"
                try? png.write(to: URL(fileURLWithPath: path))
                info["png"] = path
            }
        }
    }
    pages.append(info)
}

func walk(_ node: PDFOutline, _ depth: Int, _ out: inout [[String: Any]]) {
    for i in 0..<node.numberOfChildren {
        guard let c = node.child(at: i) else { continue }
        var e: [String: Any] = ["label": c.label ?? "", "depth": depth]
        if let d = c.destination, let p = d.page { e["page"] = doc.index(for: p); e["y"] = d.point.y }
        out.append(e)
        walk(c, depth + 1, &out)
    }
}
var outline: [[String: Any]] = []
if let root = doc.outlineRoot { walk(root, 0, &outline) }
var meta: [String: String] = [:]
for (k, v) in doc.documentAttributes ?? [:] { meta["\(k)"] = "\(v)" }
let result: [String: Any] = ["pageCount": doc.pageCount, "pages": pages, "outline": outline, "meta": meta]
let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
print(String(data: data, encoding: .utf8)!)
