import CompanionCore
import SwiftUI

/// The phone uses the same revision checks and evidence gates as the desktop.
struct LearningReviewView: View {
    let botID: String
    @EnvironmentObject private var session: Session
    @State private var page: LearningView?
    @State private var busy = false
    @State private var error: String?
    @State private var notice: String?
    @State private var rollback: LearningCandidate?

    var body: some View {
        List {
            Section {
                Text("Lessons stay inactive until task checks and a pinned trial pass. Verify actual use and reset the isolated environment between runs.").foregroundStyle(.secondary)
            }
            if let page {
                if page.candidates.isEmpty { Text("No learning candidates yet. Use /learn in a private conversation.") }
                ForEach(page.candidates) { candidate in
                    Section {
                        candidateContents(candidate)
                    } header: { Text("\(candidate.name) · \(candidate.phase)") }
                }
                Section("Recorded runs") {
                    ForEach(page.runs) { run in
                        NavigationLink("\(run.arm ?? "Task") · \(run.runtime) · \(run.quality)") {
                            LearningRunView(run: run) { body in await mutate("runs/\(run.id)", body, method: "PATCH") }
                        }
                    }
                }
                Section("Learning history") {
                    ForEach(page.events.reversed()) { event in
                        VStack(alignment: .leading) { Text(event.action).font(.headline); Text(event.detail); Text(event.at).font(.caption).foregroundStyle(.secondary) }
                    }
                }
            } else if error == nil { ProgressView("Loading learning…") }
            if let notice { Text(notice).textSelection(.enabled) }
            if let error { Text(error).foregroundStyle(.red) }
        }
        .disabled(busy)
        .navigationTitle("Learning")
        .toolbar { Button("Refresh") { Task { await load() } } }
        .task(id: session.connection?.id) { await load() }
        .alert("Roll back this learned skill?", isPresented: Binding(get: { rollback != nil }, set: { if !$0 { rollback = nil } })) {
            if let candidate = rollback {
                Button("Roll back", role: .destructive) { rollback = nil; action(candidate, "rollback") }
            }
            Button("Cancel", role: .cancel) { rollback = nil }
        } message: { Text("The bot will return to the previous skill version. The server refuses rollback if files have changed since activation.") }
    }
    @ViewBuilder private func candidateContents(_ c: LearningCandidate) -> some View {
        Text(c.gist)
        DisclosureGroup("Review changes") {
            ForEach(c.files) { file in
                Text(file.path).font(.headline)
                if let previous = c.baseFiles.first(where: { $0.path == file.path }) {
                    Text("Previous").font(.caption); Text(previous.content).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                }
                Text("Proposed").font(.caption); Text(file.content).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
            }
        }
        DisclosureGroup("Evidence") {
            ForEach(c.evidence) { evidence in
                Text(evidence.summary)
                Text(evidence.quality).font(.caption)
                if ["candidate", "validated", "trial"].contains(c.phase) {
                    Button("Verify this evidence") { Task { await mutate("candidates/\(c.id)/evidence/\(evidence.id)", .object(["revision": .number(Double(c.revision)), "quality": .string("verified")]), method: "PATCH") } }
                    Button("Dispute evidence") { Task { await mutate("candidates/\(c.id)/evidence/\(evidence.id)", .object(["revision": .number(Double(c.revision)), "quality": .string("disputed")]), method: "PATCH") } }
                }
            }
        }
        ForEach(c.evaluation.reasons, id: \.self) { Text($0).font(.footnote).foregroundStyle(.secondary) }
        ForEach(c.cases) { contract in
            DisclosureGroup(contract.title) {
                Text(contract.prompt).textSelection(.enabled)
                Text(contract.environment).font(.footnote)
                Text(contract.workspace).font(.caption).textSelection(.enabled)
                if ["candidate", "validated", "trial"].contains(c.phase) {
                    ForEach(["baseline", "candidate"], id: \.self) { arm in
                        Button("Prepare \(arm) evaluation") { replay(c, contract, arm: arm, purpose: "evaluation") }
                    }
                    if c.phase == "trial" { Button("Prepare candidate trial") { replay(c, contract, arm: "candidate", purpose: "trial") } }
                }
            }
        }
        if ["candidate", "validated", "trial"].contains(c.phase) {
            NavigationLink("Add task checks") { LearningContractView { fields in
                var body = fields; body["revision"] = .number(Double(c.revision))
                return await mutate("candidates/\(c.id)/cases", .object(body))
            } }
            NavigationLink("Revise candidate") { LearningRevisionView(candidate: c) { text, gist in
                await mutate("candidates/\(c.id)/revise", .object(["revision": .number(Double(c.revision)), "skillMd": .string(text), "gist": .string(gist)]))
            } }
        }
        if c.phase == "candidate" { Button("Validate against evidence") { action(c, "validate") } }
        if c.phase == "validated" { Button("Begin trial") { action(c, "trial") } }
        if c.phase == "trial" { Button("Activate learned skill") { action(c, "promote") } }
        if ["active", "trial"].contains(c.phase) { Button("Roll back…", role: .destructive) { rollback = c } }
        if ["candidate", "validated"].contains(c.phase) { Button("Reject candidate") { action(c, "reject") } }
    }
    private func replay(_ c: LearningCandidate, _ task: LearningCase, arm: String, purpose: String) {
        Task { await mutate("candidates/\(c.id)/replay", .object(["caseId": .string(task.id), "arm": .string(arm), "purpose": .string(purpose)])) }
    }
    private func action(_ c: LearningCandidate, _ action: String) {
        Task { await mutate("candidates/\(c.id)/\(action)", .object(["revision": .number(Double(c.revision))])) }
    }
    private func load() async {
        let id = session.connection?.id
        do {
            guard let client = session.client else { throw APIError.transport("This computer is offline.") }
            let result = try await client.learning(botID: botID)
            guard !Task.isCancelled, session.connection?.id == id else { return }
            page = result; error = nil
        } catch { if session.connection?.id == id { self.error = error.localizedDescription } }
    }
    @discardableResult private func mutate(_ path: String, _ body: PortableJSON, method: String = "POST") async -> Bool {
        guard !busy, let client = session.client else { return false }
        let id = session.connection?.id
        busy = true; defer { busy = false }
        do {
            let result = try await client.changeLearning(botID: botID, operation: path, body: body, method: method)
            guard session.connection?.id == id else { return false }
            if let message = result.object["message"]?.string {
                notice = message + "\nTask: " + (result.object["threadId"]?.string ?? "") + "\n" + (result.object["prompt"]?.string ?? "")
            }
            await load(); return true
        } catch { if session.connection?.id == id { self.error = error.localizedDescription }; return false }
    }
}

private struct LearningContractView: View {
    let save: ([String: PortableJSON]) async -> Bool
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var kind = "motivating"
    @State private var prompt = ""
    @State private var environment = ""
    @State private var workspace = ""
    @State private var checks = ""
    @State private var error: String?
    @State private var busy = false
    var body: some View {
        Form {
            TextField("Task title", text: $title)
            Picker("Task kind", selection: $kind) { Text("Motivating example").tag("motivating"); Text("Unseen variation").tag("variation") }
            TextField("Exact task text", text: $prompt, axis: .vertical)
            TextField("Isolated environment and reset instructions", text: $environment, axis: .vertical)
            TextField("Absolute workspace path on computer", text: $workspace).textInputAutocapitalization(.never)
            TextField("Checks: includes:, excludes:, or tool: on each line", text: $checks, axis: .vertical).textInputAutocapitalization(.never)
            if let error { Text(error).foregroundStyle(.red) }
            Button("Save task checks") {
                Task {
                    do {
                        let parsed = try LearningChecks.parse(checks)
                        busy = true; defer { busy = false }
                        if await save(["title": .string(title), "kind": .string(kind), "prompt": .string(prompt), "environment": .string(environment), "workspace": .string(workspace), "checks": .array(parsed)]) { dismiss() }
                        else { error = "Could not save. Return to Learning for the server's explanation." }
                    } catch { self.error = error.localizedDescription }
                }
            }.disabled(busy || [title, prompt, environment, workspace, checks].contains { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })
        }.navigationTitle("Task checks")
    }
}
private struct LearningRevisionView: View {
    let candidate: LearningCandidate
    let save: (String, String) async -> Bool
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var gist = ""
    @State private var busy = false
    var body: some View {
        Form {
            TextField("What changed", text: $gist, axis: .vertical)
            TextEditor(text: $text).font(.system(.body, design: .monospaced)).frame(minHeight: 250)
            Button("Save new revision") { Task { busy = true; defer { busy = false }; if await save(text, gist) { dismiss() } } }.disabled(busy || text.isEmpty || gist.isEmpty)
        }.navigationTitle("Revise candidate").onAppear { text = candidate.files.first { $0.path == "SKILL.md" }?.content ?? ""; gist = candidate.gist }
    }
}
private struct LearningRunView: View {
    let run: LearningRun
    let save: (PortableJSON) async -> Bool
    @Environment(\.dismiss) private var dismiss
    @State private var used: Set<String> = []
    @State private var note = ""
    @State private var busy = false
    var body: some View {
        Form {
            Section("Recorded outcome") {
                Text("\(run.runtime) · \(run.quality)")
                Text("Observed model: \(run.reportedModel ?? "not reported")")
                Text(run.output).textSelection(.enabled)
            }
            Section("Owner verification") {
                Text("Confirm actual skill use and a reset isolated environment. Reading the response alone does not prove improvement.").font(.footnote)
                ForEach(run.loaded.map(\.name), id: \.self) { name in
                    Toggle("I observed \(name) being used", isOn: Binding(get: { used.contains(name) }, set: { if $0 { used.insert(name) } else { used.remove(name) } }))
                }
                TextField("Observed outcome and environment reset", text: $note, axis: .vertical)
                Button("Verify outcome and environment") { verify("verified") }
                Button("Dispute run") { verify("disputed") }
            }
        }.disabled(busy).navigationTitle("Learning run").onAppear { used = Set(run.used); note = run.ownerNote ?? "" }
    }
    private func verify(_ quality: String) {
        Task { busy = true; defer { busy = false }; if await save(.object(["used": .array(used.sorted().map { .string($0) }), "note": .string(note), "quality": .string(quality)])) { dismiss() } }
    }
}
