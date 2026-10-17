#if DEBUG
import Foundation
import os

/// Offline UI data. No credentials, external tools, or provider calls.
final class CopilotBotPreviewProtocol: URLProtocol {
    private static let phase = OSAllocatedUnfairLock(initialState: "active")
    private static let policies = OSAllocatedUnfairLock(initialState: [String: [String: Any]]())
    private static let projects = OSAllocatedUnfairLock(initialState: [[String: Any]]())
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let path = request.url!.path
        let body: [String: Any]
        var status = 200
        if path.hasPrefix("/api/copilotbot/projects") {
            let input = requestObject()
            let id = path.components(separatedBy: "/").last ?? ""
            let items = Self.projects.withLock { values in
                if request.httpMethod == "POST" {
                    var value = input; value["id"] = UUID().uuidString; value["revision"] = 1; values.append(value)
                } else if let index = values.firstIndex(where: { $0["id"] as? String == id }) {
                    if request.httpMethod == "DELETE" { values.remove(at: index) }
                    else if request.httpMethod == "PATCH" { values[index]["collapsed"] = input["collapsed"]; values[index]["revision"] = (values[index]["revision"] as? Int ?? 0) + 1 }
                    else if request.httpMethod == "PUT" { var value = input; value["id"] = id; value["revision"] = (values[index]["revision"] as? Int ?? 0) + 1; values[index] = value }
                }
                return values
            }
            body = ["projects": items, "teams": [["id": "engineering", "name": "Engineering"], ["id": "growth", "name": "Growth"], ["id": "empty", "name": "Empty team"]]]
        } else if path.hasSuffix("/resources") {
            let scope = path + (request.url!.query ?? "")
            if request.httpMethod == "PUT" { let input = requestObject(); Self.policies.withLock { $0[scope] = input } }
            let current = Self.policies.withLock { $0[scope] } ?? ["skills": NSNull(), "mcpServers": NSNull()]
            let skills = (0..<1000).map { ["name": String(format: "skill-%04d", $0), "description": "Installed skill \($0)", "enabled": true] as [String: Any] }
            let mcps = (0..<200).map { ["name": String(format: "mcp-%03d", $0), "enabled": true] as [String: Any] }
            let inherited: [String: Any] = path.contains("/bots/") ? ["skills": ["skill-0000", "skill-0999"], "mcpServers": ["mcp-000", "mcp-199"]] : ["skills": NSNull(), "mcpServers": NSNull()]
            body = ["policy": current, "inherited": inherited, "effective": path.contains("/bots/") ? inherited : current, "catalog": ["skills": skills, "mcpServers": mcps], "busy": false]
        } else if path == "/api/config" {
            body = ["tts": ["provider": "azure", "configured": true, "voice": "alloy"], "live": ["provider": "azure", "configured": true, "voice": "marin", "readTypedReplies": true, "idleMinutes": 5]]
        } else if path == "/api/instances" { body = ["instances": []] }
        else if path == "/api/tts/voices" { body = ["voices": []] }
        else if path.hasSuffix("/learning/candidates/candidate-1/rollback") {
            if requestObject()["revision"] as? Int == 1 { Self.phase.withLock { $0 = "rolled_back" }; body = ["ok": true] }
            else { status = 409; body = ["error": "Revision changed"] }
        }
        else if path.hasSuffix("/learning") {
            body = ["candidates": [["id": "candidate-1", "revision": 1, "name": "source-checking", "phase": Self.phase.withLock { $0 },
                "gist": "Check the original source before publishing a report.", "files": [["path": "SKILL.md", "content": "Verify original sources before writing conclusions."]],
                "baseFiles": [], "evidence": [], "cases": [], "evaluation": ["ready": true, "improved": true, "reasons": []]]],
                "runs": [], "events": []]
        }
        else { status = 404; body = ["error": "Not in the offline CopilotBot fixture."] }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: (try? JSONSerialization.data(withJSONObject: body)) ?? Data())
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
    private func requestObject() -> [String: Any] {
        var data = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var bytes = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable { let count = stream.read(&bytes, maxLength: bytes.count); if count <= 0 { break }; data.append(contentsOf: bytes.prefix(count)) }
        }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }
}
#endif
