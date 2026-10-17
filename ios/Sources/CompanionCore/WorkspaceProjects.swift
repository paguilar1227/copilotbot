import Foundation

public struct WorkspaceProject: Codable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var revision: Int
    public var collapsed: Bool
    public var teamIds: [String]
    public var botIds: [String]
    public init(id: String = "", name: String = "", revision: Int = 0, collapsed: Bool = false, teamIds: [String] = [], botIds: [String] = []) {
        self.id = id; self.name = name; self.revision = revision; self.collapsed = collapsed; self.teamIds = teamIds; self.botIds = botIds
    }
}
public struct WorkspaceProjectCatalog: Codable, Sendable {
    public struct Team: Codable, Identifiable, Sendable { public var id: String; public var name: String }
    public var projects: [WorkspaceProject]
    public var teams: [Team]
    public init(projects: [WorkspaceProject] = [], teams: [Team] = []) { self.projects = projects; self.teams = teams }
    public func sidebarTeams(for project: WorkspaceProject, bots: [Bot], rooms: [Room]) -> [SidebarSection] {
        teams.filter { project.teamIds.contains($0.id) }.map { team in
            let members = bots.filter { $0.hidden != true && $0.section == team.name }
            return SidebarSection(name: team.name, chiefs: members.filter { $0.chiefOfStaff == true },
                bots: members.filter { $0.chiefOfStaff != true }, channels: rooms.filter { $0.section == team.name && $0.dm != true })
        }
    }
    public func standaloneBots(for project: WorkspaceProject, bots: [Bot]) -> [Bot] {
        bots.filter { $0.hidden != true && ($0.section ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && project.botIds.contains($0.id) }
    }
    public func teamNames(for project: WorkspaceProject) -> Set<String> {
        Set(teams.filter { project.teamIds.contains($0.id) }.map(\.name))
    }
}
extension CompanionClient {
    public func workspaceProjects() async throws -> WorkspaceProjectCatalog {
        try await send(makeRequest("GET", "/api/copilotbot/projects"), as: WorkspaceProjectCatalog.self)
    }
    public func saveWorkspaceProject(_ project: WorkspaceProject) async throws -> WorkspaceProjectCatalog {
        if !project.id.isEmpty && !Self.validRouteID(project.id) { throw APIError.badURL }
        var body: [String: PortableJSON] = ["name": .string(project.name), "collapsed": .bool(project.collapsed),
            "teamIds": .array(project.teamIds.map(PortableJSON.string)), "botIds": .array(project.botIds.map(PortableJSON.string))]
        if !project.id.isEmpty { body["revision"] = .number(Double(project.revision)) }
        return try await send(makeRequest(project.id.isEmpty ? "POST" : "PUT", "/api/copilotbot/projects" + (project.id.isEmpty ? "" : "/\(project.id)"), encodedBody: PortableJSON.object(body)), as: WorkspaceProjectCatalog.self)
    }
    public func collapseWorkspaceProject(_ project: WorkspaceProject) async throws -> WorkspaceProjectCatalog {
        guard Self.validRouteID(project.id) else { throw APIError.badURL }
        return try await send(makeRequest("PATCH", "/api/copilotbot/projects/\(project.id)", body: ["revision": project.revision, "collapsed": !project.collapsed]), as: WorkspaceProjectCatalog.self)
    }
    public func removeWorkspaceProject(_ project: WorkspaceProject) async throws -> WorkspaceProjectCatalog {
        guard Self.validRouteID(project.id) else { throw APIError.badURL }
        return try await send(makeRequest("DELETE", "/api/copilotbot/projects/\(project.id)", body: ["revision": project.revision]), as: WorkspaceProjectCatalog.self)
    }
}
