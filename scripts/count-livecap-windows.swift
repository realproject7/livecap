import CoreGraphics
import Foundation

// Count on-screen windows owned by the LiveCap app (#66 teardown/single-instance
// verification). The bundled binary is `livecap-app`, but macOS reports the
// CGWindowList owner name as the bundle display name "LiveCap"; match either.
let owners: Set<String> = ["LiveCap", "livecap-app"]
let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
let windows = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] ?? []
let count = windows.filter { owners.contains(($0[kCGWindowOwnerName as String] as? String) ?? "") }.count
print(count)
