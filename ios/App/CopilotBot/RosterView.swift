import CompanionCore
import SwiftUI

struct RosterView: View {
    var sourceBotID: String? = nil
    var sourceTeam: String? = nil
    @EnvironmentObject private var session: Session
    @State private var entries: [RosterEntry] = []
    @State private var query = ""
    @State private var selected: Set<String> = []
    @State private var busy = false
    @State private var error: String?
    @State private var notice: String?
    @State private var deleting: RosterEntry?
    @State private var requestID = UUID()
    private var matches: [RosterEntry] { entries.filter { query.isEmpty || ($0.name + " " + $0.description).localizedCaseInsensitiveContains(query) } }

    var body: some View {
        List {
            Section {
                Text("Save specialist bots and teams here, then deploy fresh copies when needed. Archive working bots to clear the sidebar without losing their history.").foregroundStyle(.secondary)
                if sourceBotID != nil || sourceTeam != nil {
                    Button("Save deployed \(sourceBotID == nil ? "team" : "bot") to roster") {
                        Task { await perform { client in try await client.saveDeployedToRoster(botID: sourceBotID, team: sourceTeam); notice = "Template saved. The deployed copy is unchanged." } }
                    }
                }
            }
            Section("\(selected.count) selected · \(entries.count) saved") {
                ForEach(matches) { entry in
                    VStack(alignment: .leading, spacing: 5) {
                        Toggle(isOn: Binding(get: { selected.contains(entry.id) }, set: { on in
                            if on { selected.insert(entry.id) } else { selected.remove(entry.id) }; requestID = UUID()
                        })) { Label(entry.name, systemImage: entry.kind == "team" ? "person.3" : "person.crop.square") }
                        if !entry.description.isEmpty { Text(entry.description).font(.caption).foregroundStyle(.secondary) }
                        Text(entry.activeCopies > 0 ? "\(entry.activeCopies) deployed copies" : "Not deployed").font(.caption).foregroundStyle(.secondary)
                        if !entry.usedBy.isEmpty { Text("Used by " + entry.usedBy.map(\.name).joined(separator: ", ")).font(.caption).foregroundStyle(.secondary) }
                        HStack {
                            NavigationLink("Edit template") { RosterEditorView(entry: entry, bots: entries.filter { $0.kind == "bot" }) }
                            Spacer()
                            Button("Delete", role: .destructive) {
                                if entry.usedBy.isEmpty { deleting = entry }
                                else { error = "Used by team templates: " + entry.usedBy.map(\.name).joined(separator: ", ") + ". Edit those teams first." }
                            }.buttonStyle(.borderless)
                        }.font(.caption)
                    }.padding(.vertical, 3)
                }
                if matches.isEmpty { Text(entries.isEmpty ? "No saved templates yet. Save one from bot or team settings." : "No matching templates.").foregroundStyle(.secondary) }
            }
            if let notice { Text(notice).foregroundStyle(.green) }
            if let error { Section { Text(error).foregroundStyle(.red); Button("Refresh roster") { Task { await load() } } } }
        }
        .navigationTitle("Saved roster")
        .searchable(text: $query, prompt: "Search bots and teams")
        .disabled(busy)
        .task(id: session.connection?.id) { await load() }
        .refreshable { await load() }
        .safeAreaInset(edge: .bottom) {
            VStack {
                Text("Fresh copies use Ask permissions and paused routines.").font(.caption).foregroundStyle(.secondary)
                Button("Deploy selected (\(selected.count))") {
                    Task { await perform { client in
                        try await client.deployRoster(entries.filter { selected.contains($0.id) }, requestID: requestID)
                        selected = []; requestID = UUID(); await session.refresh(); notice = "Deployed. Your new bots and teams are in the chat list."
                    } }
                }.buttonStyle(.borderedProminent).disabled(busy || selected.isEmpty)
            }.padding().frame(maxWidth: .infinity).background(.regularMaterial)
        }
        .confirmationDialog("Delete saved template? Deployed copies and chats are kept.", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
            if let deleting { Button("Delete \(deleting.name)", role: .destructive) { Task { await perform { client in try await client.deleteRosterEntry(deleting) }; self.deleting = nil } } }
        }
    }
    private func load() async {
        let connection = session.connection?.id
        do {
            guard let client = session.client else { return }
            let result = try await client.roster()
            guard !Task.isCancelled, session.connection?.id == connection else { return }
            entries = result; selected = selected.intersection(Set(result.map(\.id)))
        } catch { self.error = error.localizedDescription }
    }
    private func perform(_ action: (CompanionClient) async throws -> Void) async {
        guard !busy, let client = session.client else { return }
        busy = true; error = nil; notice = nil
        defer { busy = false }
        do { try await action(client); await load() } catch { self.error = error.localizedDescription }
    }
}

private struct RosterEditorView: View {
    let entry: RosterEntry
    let bots: [RosterEntry]
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var detail: RosterDetail?
    @State private var error: String?
    @State private var busy = false
    var body: some View {
        Form {
            Text("Edit the saved definition. Deployed copies are unchanged.").foregroundStyle(.secondary)
            if entry.kind == "team" {
                Text("Member IDs refer to saved bot templates:").font(.caption)
                ForEach(bots) { bot in Text("\(bot.name): \(bot.id)").font(.system(.caption, design: .monospaced)).textSelection(.enabled) }
            }
            TextEditor(text: $text).font(.system(.caption, design: .monospaced)).frame(minHeight: 400).accessibilityLabel(entry.kind == "bot" ? "Bot template YAML" : "Team template JSON")
            if let error { Text(error).foregroundStyle(.red) }
            Button("Save template") { Task { await save() } }.disabled(busy || detail == nil)
        }
        .navigationTitle("Edit \(entry.name)")
        .task {
            let connection = session.connection?.id
            do {
                guard let client = session.client else { return }
                let result = try await client.rosterDetail(entry)
                guard !Task.isCancelled, session.connection?.id == connection else { return }
                detail = result
                if let yaml = result.yaml { text = yaml }
                else if let definition = result.definition {
                    let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
                    text = String(decoding: try encoder.encode(definition), as: UTF8.self)
                }
            } catch { self.error = error.localizedDescription }
        }
    }
    private func save() async {
        guard let client = session.client, let detail, !busy else { return }
        let connection = session.connection?.id
        busy = true; defer { busy = false }
        do {
            var current = entry; current.revision = detail.revision
            try await client.saveRosterEntry(current, yaml: entry.kind == "bot" ? text : nil, definition: entry.kind == "team" ? JSONDecoder().decode(PortableJSON.self, from: Data(text.utf8)) : nil)
            if session.connection?.id == connection { dismiss() }
        } catch { self.error = error.localizedDescription }
    }
}
