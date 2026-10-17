import CompanionCore
import SwiftUI

struct ResourceAccessView: View {
    var botID: String? = nil
    var team: String = ""
    @EnvironmentObject private var session: Session
    @State private var data: ResourceState?
    @State private var error: String?

    var body: some View {
        List {
            Section {
                Text(botID == nil
                     ? "Team limits apply to every member, including bots added later. Each bot can choose a smaller set."
                     : "Choose which skills and MCP servers this bot can use. Its team's limits also apply.")
                    .foregroundStyle(.secondary)
            }
            if let data {
                resourceLink("Skills", rows: data.catalog.skills, key: \.skills, data: data)
                resourceLink("MCP servers", rows: data.catalog.mcpServers, key: \.mcpServers, data: data)
                if data.busy { Text("Stop the affected bots before changing access.").foregroundStyle(.secondary) }
            } else if error == nil { ProgressView("Loading resources…") }
            if let error { Section { Text(error).foregroundStyle(.red); Button("Retry") { Task { await load() } } } }
        }
        .navigationTitle(botID == nil ? "Team resources" : "Skills & MCPs")
        .task(id: session.connection?.id) { await load() }
        .refreshable { await load() }
    }
    private func resourceLink(_ title: String, rows: [ResourceRow], key: WritableKeyPath<ResourceAccess, [String]?>, data: ResourceState) -> some View {
        let selected = data.effective[keyPath: key]
        let count = rows.filter { $0.enabled && (selected == nil || selected!.contains($0.name)) }.count
        return NavigationLink {
            ResourcePickerView(title: title, rows: rows, key: key, data: data) { policy in
                guard let client = session.client else { throw APIError.transport("This computer is offline.") }
                let id = session.connection?.id
                let result = try await client.saveResources(policy, botID: botID, team: team)
                guard session.connection?.id == id else { throw APIError.transport("The connected computer changed. Reopen settings.") }
                self.data = result
            }
        } label: {
            HStack { Text(title); Spacer(); Text("\(count) of \(rows.count)").foregroundStyle(.secondary) }
        }
        .accessibilityIdentifier(title == "Skills" ? "resources-skills" : "resources-mcps")
    }
    private func load() async {
        let id = session.connection?.id
        data = nil; error = nil
        do {
            guard let client = session.client else { throw APIError.transport("This computer is offline.") }
            let result = try await client.resources(botID: botID, team: team)
            guard !Task.isCancelled, session.connection?.id == id else { return }
            data = result
        } catch { if session.connection?.id == id { self.error = error.localizedDescription } }
    }
}

private struct ResourcePickerView: View {
    let title: String
    let rows: [ResourceRow]
    let key: WritableKeyPath<ResourceAccess, [String]?>
    let data: ResourceState
    let save: (ResourceAccess) async throws -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var policy: ResourceAccess
    @State private var query = ""
    @State private var saving = false
    @State private var error: String?
    init(title: String, rows: [ResourceRow], key: WritableKeyPath<ResourceAccess, [String]?>, data: ResourceState, save: @escaping (ResourceAccess) async throws -> Void) {
        self.title = title; self.rows = rows; self.key = key; self.data = data; self.save = save
        _policy = State(initialValue: data.policy)
    }
    private var allRows: [ResourceRow] {
        rows + (policy[keyPath: key] ?? []).filter { name in !rows.contains { $0.name == name } }.map { ResourceRow(name: $0, enabled: false) }
    }
    private var selected: [String]? { policy[keyPath: key] }
    private func allowed(_ name: String) -> Bool { data.inherited[keyPath: key]?.contains(name) ?? true }
    private func checked(_ row: ResourceRow) -> Bool { allowed(row.name) && (selected?.contains(row.name) ?? row.enabled) }
    private var matches: [ResourceRow] {
        allRows.filter { query.isEmpty || ($0.name + " " + ($0.description ?? "")).localizedCaseInsensitiveContains(query) }
    }
    var body: some View {
        List {
            Section {
                Picker("Access", selection: Binding(get: { selected == nil ? "all" : selected!.isEmpty ? "none" : "selected" }, set: { mode in
                    policy[keyPath: key] = mode == "all" ? nil : mode == "none" ? [] : rows.filter { $0.enabled && allowed($0.name) }.map(\.name)
                })) {
                    Text("All available").tag("all"); Text("Selected only").tag("selected"); Text("None").tag("none")
                }
                Text("\(allRows.filter(checked).count) of \(allRows.count) selected")
                    .accessibilityIdentifier("resource-selected-count")
                if let inherited = data.inherited[keyPath: key] { Text("Team allows \(inherited.count). Other entries are locked.").font(.footnote).foregroundStyle(.secondary) }
            }
            Section {
                ForEach(matches) { row in
                    Toggle(isOn: Binding(get: { checked(row) }, set: { enabled in
                        var names = selected ?? rows.filter(\.enabled).map(\.name)
                        names.removeAll { $0 == row.name }
                        if enabled { names.append(row.name) }
                        policy[keyPath: key] = names
                    })) {
                        VStack(alignment: .leading) {
                            Text(row.name)
                            if let description = row.description { Text(description).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                            if !allowed(row.name) { Text("Not allowed by team").font(.caption).foregroundStyle(.secondary) }
                            else if !row.enabled { Text("Missing or disabled on computer").font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                    .accessibilityIdentifier("resource-\(row.name)")
                    .disabled(!allowed(row.name) || (!row.enabled && !(selected?.contains(row.name) ?? false)))
                }
                if matches.isEmpty { Text(query.isEmpty ? "No resources configured on your computer." : "No matching resources.").foregroundStyle(.secondary) }
            }
            if let error { Text(error).foregroundStyle(.red) }
        }
        .searchable(text: $query, prompt: "Search \(title.lowercased())")
        .navigationTitle(title)
        .disabled(saving || data.busy)
        .safeAreaInset(edge: .bottom) {
            Button("Save changes") { Task { saving = true; defer { saving = false }; do { try await save(policy); dismiss() } catch { self.error = error.localizedDescription } } }
                .accessibilityIdentifier("resource-save")
                .buttonStyle(.borderedProminent)
                .disabled(saving || data.busy || policy == data.policy)
                .frame(maxWidth: .infinity)
                .padding()
                .background(.regularMaterial)
        }
    }
}
