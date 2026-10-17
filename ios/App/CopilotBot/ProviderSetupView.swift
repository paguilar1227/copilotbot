import CompanionCore
import SwiftUI

struct ProviderSetupView: View {
    @EnvironmentObject private var session: Session
    @State private var provider = "copilot"
    @State private var auth: ProviderSignIn?
    @State private var error: String?
    @State private var busy = false
    var body: some View {
        Form {
            Section {
                Picker("Provider", selection: $provider) { Text("GitHub Copilot").tag("copilot"); Text("Azure Entra ID").tag("azure") }
                    .disabled(auth?.phase == "waiting")
                Text("Signs in the CLI on your paired computer. Provider tokens stay there. If the CLI is missing, install it on that computer and return here.").font(.footnote).foregroundStyle(.secondary)
                Button("Start device sign-in") { Task { await start() } }.disabled(busy || auth?.phase == "waiting")
            }
            if let auth {
                Section("Sign-in") {
                    Text(auth.phase.capitalized)
                    if let message = auth.message { Text(message) }
                    if auth.phase == "waiting", let url = auth.validatedURL(provider: provider), let code = auth.userCode {
                        Text(code).font(.system(.title, design: .monospaced)).textSelection(.enabled)
                        Link("Open sign-in page", destination: url)
                        Text("Enter this code yourself on the provider's page. Never enter a password in CopilotBot.").font(.footnote)
                    } else if auth.phase == "waiting" {
                        Text("Waiting for a valid device code from the computer…")
                    }
                    if auth.phase == "waiting" { Button("Cancel sign-in") { Task { await cancel() } } }
                }
            }
            if let error { Text(error).foregroundStyle(.red) }
        }
        .navigationTitle("Provider sign-in")
        .task(id: auth?.flowId) {
            let connectionID = session.connection?.id
            while !Task.isCancelled, auth?.phase == "waiting", let flowID = auth?.flowId, let client = session.client {
                do {
                    // The existing provider controller supplies and owns the flow expiry.
                    try await Task.sleep(for: .seconds(2))
                    let state = try await client.providerSignIn(provider: provider, action: "status", flowID: flowID)
                    guard session.connection?.id == connectionID else { return }
                    auth = state
                } catch is CancellationError { return }
                catch { self.error = error.localizedDescription; return }
            }
        }
    }
    private func start() async {
        guard let client = session.client else { return }
        let id = session.connection?.id
        busy = true; defer { busy = false }
        do { let state = try await client.providerSignIn(provider: provider, action: "start"); guard session.connection?.id == id else { return }; auth = state; error = nil }
        catch { self.error = error.localizedDescription }
    }
    private func cancel() async {
        guard let client = session.client else { return }
        do { _ = try await client.providerSignIn(provider: provider, action: "cancel", flowID: auth?.flowId); auth = nil }
        catch { self.error = error.localizedDescription }
    }
}
