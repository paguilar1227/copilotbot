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
    @State private var entries: [BotTemplateBatchEntry] = []
    @State private var imported: Set<String> = []
    @State private var failures: [String: String] = [:]
    @State private var fileErrors: [String] = []
    @State private var activateRoutines = false
    @State private var busy = false
    @State private var error: String?
    private var ready: [BotTemplateBatchEntry] { entries.filter { $0.preview != nil && !imported.contains($0.id) } }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Button("Create a new bot", systemImage: "plus.bubble") {
                        Task {
                            if let bot = await session.createCopilotBot(template: nil) { dismiss(); created(bot) }
                            else { error = session.actionError }
                        }
                    }
                    Button("Import YAML files", systemImage: "square.and.arrow.down") { importing = true }
                }
                if !entries.isEmpty {
                    Section("Review imports") {
                        Text("\(imported.count) imported · \(ready.count) ready · \(entries.filter { $0.preview == nil }.count) invalid")
                        Text("Review the settings for each bot. Invalid templates are skipped. Credentials stay on your computer.").font(.footnote).foregroundStyle(.secondary)
                        ForEach(entries) { entry in
                            if let preview = entry.preview {
                                DisclosureGroup("\(preview.name)\(imported.contains(entry.id) ? " · Imported" : "")") {
                                    Text("\(entry.filename) · document \(entry.document)").font(.caption)
                                    LabeledContent("Permissions", value: preview.defaults.object["profile"]?.object["approvalMode"]?.string ?? "Ask")
                                    Text(String(data: (try? JSONEncoder().encode(preview.defaults)) ?? Data(), encoding: .utf8) ?? "")
                                        .font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                                    ForEach(preview.warnings, id: \.self) { Text($0).foregroundStyle(.orange) }
                                    if let failure = failures[entry.id] { Text(failure).foregroundStyle(.red) }
                                }
                            } else {
                                VStack(alignment: .leading) {
                                    Text("\(entry.filename) · document \(entry.document) · Invalid").bold()
                                    ForEach(Array(entry.diagnostics.enumerated()), id: \.offset) { _, issue in Text(issue.description) }
                                }.foregroundStyle(.red)
                            }
                        }
                        Toggle("Enable imported schedules", isOn: $activateRoutines)
                        Text("Schedules start paused unless you turn this on.").font(.footnote).foregroundStyle(.secondary)
                        Button("Create \(ready.count) reviewed bots") { Task { await createImports() } }
                            .disabled(ready.isEmpty).accessibilityIdentifier("create-imported-bot")
                    }
                }
                ForEach(fileErrors, id: \.self) { Text($0).foregroundStyle(.red) }
                if let error { Text(error).foregroundStyle(.red) }
                if busy { ProgressView() }
            }
            .disabled(busy)
            .navigationTitle("New bot")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(imported.isEmpty ? "Cancel" : "Done") { dismiss() }.disabled(busy) } }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.yaml, .plainText, .data], allowsMultipleSelection: true) { result in
                Task {
                    busy = true; defer { busy = false }
                    do {
                        let urls = try result.get()
                        guard let client = session.client else { throw APIError.transport("This computer is offline.") }
                        let connectionID = session.connection?.id
                        var parsed: [BotTemplateBatchEntry] = []
                        var errors: [String] = []
                        for (index, url) in urls.enumerated() {
                            let access = url.startAccessingSecurityScopedResource()
                            defer { if access { url.stopAccessingSecurityScopedResource() } }
                            do {
                                let bytes = try Data(contentsOf: url, options: .mappedIfSafe)
                                let templateLimit = 900_000 + ((AttachmentPolicy.maximumImageBytes + 2) / 3) * 4
                                guard bytes.count <= templateLimit, let text = String(data: bytes, encoding: .utf8) else { throw APIError.transport("Choose UTF-8 YAML within the settings and avatar size limits.") }
                                let batch = try await client.previewTemplates(filename: url.lastPathComponent, yaml: text)
                                parsed += batch.templates.map { entry in var copy = entry; copy.id = "\(index):\(entry.document)"; return copy }
                            } catch { errors.append("\(url.lastPathComponent): \(error.localizedDescription)") }
                        }
                        guard session.connection?.id == connectionID else { return }
                        entries = parsed; imported = []; failures = [:]; fileErrors = errors; error = nil
                    } catch { self.error = error.localizedDescription }
                }
            }
        }
    }
    private func createImports() async {
        busy = true; defer { busy = false }
        let connectionID = session.connection?.id
        for entry in ready {
            guard session.connection?.id == connectionID else { error = "Connection changed. Review remaining imports."; return }
            if let template = entry.preview, let bot = await session.createCopilotBot(template: template.choosingRoutines(enabled: activateRoutines)) {
                imported.insert(entry.id); failures[entry.id] = nil; created(bot)
            } else {
                failures[entry.id] = session.actionError ?? "Could not create this bot."
            }
        }
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
