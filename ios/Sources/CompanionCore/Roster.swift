import Foundation

public struct RosterAvatar: Decodable, Sendable {
    public var name: String
    public var title: String?
    public var description: String?
    public var color: String
    public var mascotBody: String?
    public var mascotExpression: String?
    public var avatarUrl: String?
    public var avatarCrop: AvatarCrop?
    public var avatarZoom: Double?
    public var avatarFocusX: Double?
    public var avatarFocusY: Double?
}
public struct RosterEntry: Decodable, Identifiable, Sendable {
    public struct Reference: Decodable, Sendable { public var id: String; public var name: String }
    public var id: String
    public var kind: String
    public var name: String
    public var description: String
    public var revision: Int
    public var memberCount: Int
    public var usedBy: [Reference]
    public var activeCopies: Int
    public var avatars: [RosterAvatar]?
}
public struct RosterDetail: Decodable, Sendable {
    public var revision: Int
    public var yaml: String?
    public var definition: PortableJSON?
}
private struct RosterListing: Decodable { var entries: [RosterEntry] }

extension CompanionClient {
    public func roster() async throws -> [RosterEntry] {
        try await send(makeRequest("GET", "/api/copilotbot/roster"), as: RosterListing.self).entries
    }
    public func rosterDetail(_ entry: RosterEntry) async throws -> RosterDetail {
        guard Self.validRouteID(entry.id), ["bot", "team"].contains(entry.kind) else { throw APIError.badURL }
        return try await send(makeRequest("GET", "/api/copilotbot/roster/\(entry.kind)s/\(entry.id)"), as: RosterDetail.self)
    }
    public func saveDeployedToRoster(botID: String? = nil, team: String? = nil) async throws {
        let path = botID == nil ? "teams" : "bots"
        if let botID, !Self.validRouteID(botID) { throw APIError.badURL }
        _ = try await send(makeRequest("POST", "/api/copilotbot/roster/\(path)", body: botID.map { ["botId": $0] } ?? ["section": team ?? ""]), as: PortableJSON.self)
    }
    public func saveRosterEntry(_ entry: RosterEntry, yaml: String? = nil, definition: PortableJSON? = nil) async throws {
        guard Self.validRouteID(entry.id), ["bot", "team"].contains(entry.kind) else { throw APIError.badURL }
        var body: [String: PortableJSON] = ["revision": .number(Double(entry.revision))]
        if let yaml { body["yaml"] = .string(yaml) }
        if let definition { body["definition"] = definition }
        _ = try await send(makeRequest("PUT", "/api/copilotbot/roster/\(entry.kind)s/\(entry.id)", encodedBody: PortableJSON.object(body)), as: PortableJSON.self)
    }
    public func deleteRosterEntry(_ entry: RosterEntry) async throws {
        guard Self.validRouteID(entry.id), ["bot", "team"].contains(entry.kind) else { throw APIError.badURL }
        _ = try await send(makeRequest("DELETE", "/api/copilotbot/roster/\(entry.kind)s/\(entry.id)", body: ["revision": entry.revision]), as: PortableJSON.self)
    }
    public func deployRoster(_ entries: [RosterEntry], requestID: UUID) async throws {
        guard entries.allSatisfy({ Self.validRouteID($0.id) && ["bot", "team"].contains($0.kind) }) else { throw APIError.badURL }
        _ = try await send(makeRequest("POST", "/api/copilotbot/roster/deploy", body: ["requestId": requestID.uuidString, "selections": entries.map { ["id": $0.id, "kind": $0.kind] }]), as: PortableJSON.self)
    }
}
