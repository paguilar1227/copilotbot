import Foundation
/// The same suite can exercise the untouched upstream app or the downstream build.
final class CompanionTestApp: NSObject {
    static let bundleID = Bundle(for: CompanionTestApp.self).object(forInfoDictionaryKey: "CopilotBotAppBundleID") as? String ?? "com.openmausbot.app"
}
