import CompanionCore
import SwiftUI
import UniformTypeIdentifiers

struct BotYAMLDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.yaml, .plainText] }
    var text: String
    init(text: String) { self.text = text }
    init(configuration: ReadConfiguration) throws {
        guard let data = configuration.file.regularFileContents, let value = String(data: data, encoding: .utf8) else { throw CocoaError(.fileReadCorruptFile) }
        text = value
    }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: Data(text.utf8)) }
}

struct NewCopilotBotView: View {
    var created: (Bot) -> Void
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @State private var importing = false
    @State private var preview: BotTemplatePreview?
    @State private var filename = ""
    @State private var activateRoutines = false
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Button("Create a new bot", systemImage: "plus.bubble") { Task { await create() } }
                    Button("Import YAML from file", systemImage: "square.and.arrow.down") { importing = true }
                }
                if let preview {
                    Section("Review import") {
                        LabeledContent("File", value: filename)
                        LabeledContent("Bot", value: preview.name)
                        Text("Imports reusable settings, routines and resource selections. Credentials stay on your computer. Review permissions and any enabled schedules before creating this bot.")
                            .font(.footnote).foregroundStyle(.secondary)
                        LabeledContent("Permissions", value: preview.defaults.object["profile"]?.object["approvalMode"]?.string ?? "Workspace default")
                        DisclosureGroup("All imported settings") {
                            Text(String(data: (try? JSONEncoder().encode(preview.defaults)) ?? Data(), encoding: .utf8) ?? "")
                                .font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                        }
                        ForEach(preview.warnings, id: \.self) { Text($0).foregroundStyle(.orange) }
                        Toggle("Enable imported schedules", isOn: $activateRoutines)
                        Text("Schedules start paused unless you turn this on. You can enable them later in Routines.").font(.footnote).foregroundStyle(.secondary)
                        Button("Create imported bot") { Task { await create(preview.choosingRoutines(enabled: activateRoutines)) } }
                            .accessibilityIdentifier("create-imported-bot")
                    }
                }
                if let error { Text(error).foregroundStyle(.red) }
                if busy { ProgressView() }
            }
            .disabled(busy)
            .navigationTitle("New bot")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.yaml, .plainText, .data]) { result in
                Task {
                    do {
                        let url = try result.get()
                        let access = url.startAccessingSecurityScopedResource()
                        defer { if access { url.stopAccessingSecurityScopedResource() } }
                        // Same byte contract as the server's YAML parser.
                        let bytes = try Data(contentsOf: url, options: .mappedIfSafe)
                        guard bytes.count <= 900_000, let text = String(data: bytes, encoding: .utf8) else { throw APIError.transport("Choose a UTF-8 YAML template no larger than 900 KB.") }
                        guard let client = session.client else { throw APIError.transport("This computer is offline.") }
                        let id = session.connection?.id
                        busy = true; defer { busy = false }
                        let parsed = try await client.previewTemplate(text)
                        guard session.connection?.id == id else { return }
                        preview = parsed; filename = url.lastPathComponent; error = nil
                    } catch { self.error = error.localizedDescription }
                }
            }
        }
    }
    private func create(_ template: BotTemplatePreview? = nil) async {
        busy = true; defer { busy = false }
        if let bot = await session.createCopilotBot(template: template) { dismiss(); created(bot) }
        else { error = session.actionError }
    }
}

struct ExportBotTemplateButton: View {
    let botID: String
    @EnvironmentObject private var session: Session
    @State private var file: BotYAMLDocument?
    @State private var name = "bot.bot.yaml"
    @State private var exporting = false
    @State private var busy = false
    @State private var error: String?
    var body: some View {
        Button("Export bot as YAML", systemImage: "square.and.arrow.up") {
            Task {
                busy = true; defer { busy = false }
                do {
                    guard let client = session.client else { throw APIError.transport("This computer is offline.") }
                    let id = session.connection?.id
                    let result = try await client.exportTemplate(botID: botID)
                    guard session.connection?.id == id else { return }
                    file = BotYAMLDocument(text: result.yaml); name = result.filename; exporting = true
                } catch { self.error = error.localizedDescription }
            }
        }
        .disabled(busy)
        .fileExporter(isPresented: $exporting, document: file, contentType: .yaml, defaultFilename: name) { result in
            if case let .failure(problem) = result { error = problem.localizedDescription }
        }
        .alert("Couldn't export", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) { Button("OK") { error = nil } } message: { Text(error ?? "") }
    }
}
