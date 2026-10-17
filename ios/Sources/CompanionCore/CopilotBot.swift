import Foundation

/// Downstream wire contracts are kept together so upstream client updates stay small.
public struct ResourceAccess: Codable, Equatable, Sendable {
    public var skills: [String]?
    public var mcpServers: [String]?
    public init(skills: [String]? = nil, mcpServers: [String]? = nil) {
        self.skills = skills; self.mcpServers = mcpServers
    }
    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        // Null means all; an empty array means none. Neither may be omitted.
        if let skills { try c.encode(skills, forKey: .skills) } else { try c.encodeNil(forKey: .skills) }
        if let mcpServers { try c.encode(mcpServers, forKey: .mcpServers) } else { try c.encodeNil(forKey: .mcpServers) }
    }
}
public struct ResourceRow: Codable, Identifiable, Sendable {
    public var name: String
    public var enabled: Bool
    public var description: String?
    public var origin: String?
    public var source: String?
    public var displayName: String?
    public var id: String { name }
    public init(name: String, enabled: Bool, description: String? = nil, origin: String? = nil) { self.name = name; self.enabled = enabled; self.description = description; self.origin = origin }
}
public struct ResourceState: Codable, Sendable {
    public struct Catalog: Codable, Sendable {
        public var skills: [ResourceRow]
        public var mcpServers: [ResourceRow]
    }
    public var policy: ResourceAccess
    public var inherited: ResourceAccess
    public var effective: ResourceAccess
    public var catalog: Catalog
    public var busy: Bool
    public var warnings: [String]?
}

/// Lossless JSON for portable settings and revisioned learning operations.
/// No YAML interpretation takes place on the phone; the server validates it.
public enum PortableJSON: Codable, Equatable, Sendable {
    case object([String: PortableJSON]), array([PortableJSON]), string(String), number(Double), bool(Bool), null
    public init(from decoder: any Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([String: PortableJSON].self) { self = .object(v) }
        else { self = .array(try c.decode([PortableJSON].self)) }
    }
    public func encode(to encoder: any Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case let .object(v): try c.encode(v)
        case let .array(v): try c.encode(v)
        case let .string(v): try c.encode(v)
        case let .number(v): try c.encode(v)
        case let .bool(v): try c.encode(v)
        case .null: try c.encodeNil()
        }
    }
    public var object: [String: PortableJSON] { if case let .object(v) = self { v } else { [:] } }
    public var string: String { if case let .string(v) = self { v } else { "" } }
}
public struct BotTemplatePreview: Decodable, Sendable {
    public var defaults: PortableJSON
    public var warnings: [String]
    public var name: String { defaults.object["profile"]?.object["name"]?.string ?? "Imported bot" }
    public func choosingRoutines(enabled: Bool) -> BotTemplatePreview {
        var copy = self
        var values = defaults.object
        if case let .array(routines)? = values["routines"] {
            values["routines"] = .array(routines.map { routine in
                var fields = routine.object
                if !enabled { fields["enabled"] = .bool(false) }
                return .object(fields)
            })
        }
        copy.defaults = .object(values)
        return copy
    }
    public var creationBody: PortableJSON {
        return .object(["template": defaults, "useDefaults": .bool(false)])
    }
}
public struct TemplateDiagnostic: Decodable, Sendable {
    public var path: String
    public var message: String
    public var line: Int?
    public var column: Int?
    public var description: String { "\(path)\(line.map { " (line \($0))" } ?? ""): \(message)" }
}
public struct BotTemplateBatchEntry: Decodable, Sendable, Identifiable {
    public var id: String
    public var filename: String
    public var document: Int
    public var defaults: PortableJSON?
    public var warnings: [String]
    public var diagnostics: [TemplateDiagnostic]
    public var preview: BotTemplatePreview? {
        guard let defaults else { return nil }
        return BotTemplatePreview(defaults: defaults, warnings: warnings)
    }
}
public struct BotTemplateBatch: Decodable, Sendable { public var templates: [BotTemplateBatchEntry] }
public struct BotTemplateFile: Codable, Sendable { public var filename: String; public var yaml: String }
public struct LearningView: Decodable, Sendable {
    public var candidates: [LearningCandidate]
    public var runs: [LearningRun]
    public var events: [LearningEvent]
}
public struct LearningCandidate: Decodable, Identifiable, Sendable {
    public var id: String; public var revision: Int; public var name: String; public var phase: String
    public var gist: String; public var files: [LearningFile]; public var baseFiles: [LearningFile]
    public var evidence: [LearningEvidence]; public var cases: [LearningCase]; public var evaluation: LearningEvaluation
}
public struct LearningFile: Decodable, Identifiable, Sendable {
    public var path: String; public var content: String; public var id: String { path }
}
public struct LearningEvidence: Decodable, Identifiable, Sendable {
    public var id: String; public var quality: String; public var summary: String
}
public struct LearningCase: Decodable, Identifiable, Sendable {
    public var id: String; public var title: String; public var kind: String
    public var prompt: String; public var environment: String; public var workspace: String
}
public struct LearningEvaluation: Decodable, Sendable {
    public var ready: Bool; public var improved: Bool; public var reasons: [String]
}
public struct LearningRun: Decodable, Identifiable, Sendable {
    public struct Loaded: Decodable, Sendable { public var name: String }
    public var id: String; public var threadId: String; public var output: String; public var quality: String
    public var runtime: String; public var arm: String?; public var purpose: String?; public var reportedModel: String?
    public var ownerNote: String?; public var loaded: [Loaded]; public var used: [String]; public var transportOk: Bool?
}
public struct LearningEvent: Decodable, Identifiable, Sendable {
    public var id: String; public var at: String; public var action: String; public var detail: String
}

extension CompanionClient {
    public func resources(botID: String? = nil, team: String = "") async throws -> ResourceState {
        if let botID, !Self.validRouteID(botID) { throw APIError.badURL }
        let path = botID.map { "/api/copilotbot/bots/\($0)/resources" } ?? "/api/copilotbot/resources"
        return try await send(makeRequest("GET", path, query: botID == nil ? [URLQueryItem(name: "section", value: team)] : []), as: ResourceState.self)
    }
    public func saveResources(_ policy: ResourceAccess, botID: String? = nil, team: String = "") async throws -> ResourceState {
        if let botID, !Self.validRouteID(botID) { throw APIError.badURL }
        let path = botID.map { "/api/copilotbot/bots/\($0)/resources" } ?? "/api/copilotbot/resources"
        var request = try makeRequest("PUT", path, query: botID == nil ? [URLQueryItem(name: "section", value: team)] : [])
        request.httpBody = try JSONEncoder().encode(policy)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return try await send(request, as: ResourceState.self)
    }
    public func previewTemplate(_ yaml: String) async throws -> BotTemplatePreview {
        try await send(makeRequest("POST", "/api/copilotbot/bot-template", body: ["yaml": yaml]), as: BotTemplatePreview.self)
    }
    public func previewTemplates(filename: String, yaml: String) async throws -> BotTemplateBatch {
        try await send(makeRequest("POST", "/api/copilotbot/bot-templates", body: ["files": [["filename": filename, "yaml": yaml]]]), as: BotTemplateBatch.self)
    }
    public func createFromTemplate(_ preview: BotTemplatePreview) async throws -> Bot {
        try await send(makeRequest("POST", "/api/bots", encodedBody: preview.creationBody), as: CreatedBot.self).bot
    }
    public func exportTemplate(botID: String) async throws -> BotTemplateFile {
        guard Self.validRouteID(botID) else { throw APIError.badURL }
        return try await send(makeRequest("GET", "/api/copilotbot/bots/\(botID)/template"), as: BotTemplateFile.self)
    }
    public func learning(botID: String) async throws -> LearningView {
        guard Self.validRouteID(botID) else { throw APIError.badURL }
        return try await send(makeRequest("GET", "/api/bots/\(botID)/learning"), as: LearningView.self)
    }
    public func changeLearning(botID: String, operation: String, body: PortableJSON, method: String = "POST") async throws -> PortableJSON {
        guard Self.validRouteID(botID), operation.split(separator: "/").allSatisfy({ Self.validRouteID(String($0)) }) else { throw APIError.badURL }
        return try await send(makeRequest(method, "/api/bots/\(botID)/learning/\(operation)", encodedBody: body), as: PortableJSON.self)
    }
}

public enum LearningChecks {
    public static func parse(_ text: String) throws -> [PortableJSON] {
        let kinds = ["includes": "output_includes", "excludes": "output_excludes", "tool": "tool_succeeded"]
        let lines = text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        guard !lines.isEmpty else { throw APIError.transport("Enter at least one task check.") }
        return try lines.map { line in
            guard let colon = line.firstIndex(of: ":"), let kind = kinds[String(line[..<colon])], !line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces).isEmpty else {
                throw APIError.transport("Start each check with includes:, excludes: or tool:, then its expected value.")
            }
            return .object(["kind": .string(kind), "value": .string(line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces))])
        }
    }
}

public struct ProviderSignIn: Decodable, Sendable {
    public var phase: String
    public var flowId: String?
    public var authorizationUrl: String?
    public var userCode: String?
    public var message: String?
    public func validatedURL(provider: String) -> URL? {
        guard let raw = authorizationUrl, let code = userCode else { return nil }
        let pattern = provider == "copilot" ? "^[A-Z0-9]{4}-[A-Z0-9]{4}$" : "^[A-Z0-9]{8,12}$"
        guard code.range(of: pattern, options: .regularExpression) != nil else { return nil }
        let allowed = provider == "copilot" ? ["https://github.com/login/device", "https://github.com/login/device/"] : ["https://microsoft.com/devicelogin", "https://microsoft.com/devicelogin/", "https://login.microsoftonline.com/common/oauth2/deviceauth", "https://login.microsoftonline.com/common/oauth2/deviceauth/"]
        return allowed.contains(raw) ? URL(string: raw) : nil
    }
}
extension CompanionClient {
    public func providerSignIn(provider: String, action: String, flowID: String? = nil) async throws -> ProviderSignIn? {
        guard ["copilot", "azure"].contains(provider), ["start", "status", "cancel"].contains(action) else { throw APIError.badURL }
        let path = "/api/instances/\(provider)/auth/\(action)"
        if action == "cancel" {
            try await send(makeRequest("POST", path, body: ["flowId": flowID ?? ""])); return nil
        }
        struct Response: Decodable { var auth: ProviderSignIn }
        let request = action == "status"
            ? try makeRequest("GET", path, query: [URLQueryItem(name: "flowId", value: flowID ?? "")])
            : try makeRequest("POST", path, body: [:])
        return try await send(request, as: Response.self).auth
    }
}
