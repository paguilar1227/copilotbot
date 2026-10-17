import SwiftUI
import CompanionCore

struct WorkspaceProjectsView: View {
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @Binding var catalog: WorkspaceProjectCatalog
    @State private var editing: WorkspaceProject?
    @State private var error: String?
    var body: some View {
        List {
            Section {
                Button("New project", systemImage: "folder.badge.plus") { editing = WorkspaceProject() }
                ForEach(catalog.projects) { project in
                    Button { editing = project } label: {
                        Label { VStack(alignment: .leading) {
                            Text(project.name).foregroundStyle(.primary)
                            Text("\(project.teamIds.count) teams · \(project.botIds.count) individual bots").font(.caption).foregroundStyle(.secondary)
                        } } icon: { Image(systemName: "folder") }
                    }
                }
            } footer: { Text("Projects organize teams and individual bots. Removing a project keeps its teams, bots, chats and settings.") }
            if let error { Text(error).foregroundStyle(.red) }
        }
        .navigationTitle("Projects")
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        .task {
            guard let client = session.client else { return }
            do { catalog = try await client.workspaceProjects() } catch { self.error = error.localizedDescription }
        }
        .sheet(item: $editing) { project in
            NavigationStack { WorkspaceProjectEditor(project: project, catalog: $catalog) }
        }
    }
}

private struct WorkspaceProjectEditor: View {
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @State var project: WorkspaceProject
    @Binding var catalog: WorkspaceProjectCatalog
    @State private var query = ""
    @State private var pending = false
    @State private var removing = false
    @State private var error: String?
    private var bots: [Bot] { session.state.bots.filter { $0.hidden != true && ($0.section ?? "").isEmpty } }
    var body: some View {
        Form {
            Section { TextField("Project name", text: $project.name) }
            Section { TextField("Search teams and bots", text: $query).textInputAutocapitalization(.never) }
            Section("Teams · \(catalog.teams.filter { project.teamIds.contains($0.id) }.count) selected") {
                ForEach(catalog.teams.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) }) { team in
                    Toggle(team.name, isOn: selection(team.id, teams: true))
                }
            }
            Section {
                ForEach(bots.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) }) { bot in
                    Toggle(bot.name, isOn: selection(bot.id, teams: false))
                }
            } header: { Text("Individual bots · \(bots.filter { project.botIds.contains($0.id) }.count) selected") }
              footer: { Text("A team’s bots follow its project. Selecting an item moves it from its current project.") }
            if let error { Text(error).foregroundStyle(.red) }
            if !project.id.isEmpty { Button("Remove project", role: .destructive) { removing = true } }
        }
        .disabled(pending)
        .navigationTitle(project.id.isEmpty ? "New project" : "Edit project")
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(pending) }
            ToolbarItem(placement: .confirmationAction) { Button("Save") { save() }.disabled(pending || project.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
        }
        .interactiveDismissDisabled(pending)
        .confirmationDialog("Remove \(project.name)?", isPresented: $removing, titleVisibility: .visible) {
            Button("Remove project", role: .destructive) { remove() }
        } message: { Text("Only the divider is removed. Teams, bots, chats and settings return to the main list.") }
    }
    private func selection(_ id: String, teams: Bool) -> Binding<Bool> {
        Binding(get: { (teams ? project.teamIds : project.botIds).contains(id) }, set: { selected in
            if teams { project.teamIds.removeAll { $0 == id }; if selected { project.teamIds.append(id) } }
            else { project.botIds.removeAll { $0 == id }; if selected { project.botIds.append(id) } }
        })
    }
    private func save() {
        guard let client = session.client, !pending else { return }
        pending = true; error = nil
        var value = project
        value.name = value.name.trimmingCharacters(in: .whitespacesAndNewlines)
        value.teamIds = value.teamIds.filter { id in catalog.teams.contains { $0.id == id } }
        value.botIds = value.botIds.filter { id in bots.contains { $0.id == id } }
        Task { do { catalog = try await client.saveWorkspaceProject(value); dismiss() } catch { self.error = error.localizedDescription }; pending = false }
    }
    private func remove() {
        guard let client = session.client, !pending else { return }
        pending = true; error = nil
        Task { do { catalog = try await client.removeWorkspaceProject(project); dismiss() } catch { self.error = error.localizedDescription }; pending = false }
    }
}
