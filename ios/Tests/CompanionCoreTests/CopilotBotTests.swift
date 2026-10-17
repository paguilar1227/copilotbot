import XCTest
@testable import CompanionCore

final class CopilotBotTests: XCTestCase {
    func testResourcePolicyDistinguishesAllFromNoneWithoutTruncatingCatalog() throws {
        let encoder = JSONEncoder()
        let all = try JSONSerialization.jsonObject(with: encoder.encode(ResourceAccess())) as! [String: Any]
        XCTAssertTrue(all["skills"] is NSNull)
        XCTAssertTrue(all["mcpServers"] is NSNull)
        let names = (0..<1000).map { "skill-\($0)" }
        let policy = ResourceAccess(skills: names, mcpServers: [])
        XCTAssertEqual(try JSONDecoder().decode(ResourceAccess.self, from: encoder.encode(policy)), policy)
        XCTAssertEqual(policy.skills?.count, 1000)
    }
    func testPortableTemplateKeepsAllSettingsAndDoesNotMutateWorkspaceDefaults() throws {
        let json = #"{"defaults":{"profile":{"name":"Research","modelSelection":{"instanceId":"copilot","model":"gpt-6","effort":"high"},"mcpServers":[]},"routines":[{"name":"Review"}],"librarySkills":["research"]},"warnings":[]}"#
        let preview = try JSONDecoder().decode(BotTemplatePreview.self, from: Data(json.utf8))
        XCTAssertEqual(preview.name, "Research")
        XCTAssertEqual(preview.creationBody.object["template"], preview.defaults)
        XCTAssertEqual(preview.creationBody.object["useDefaults"], .bool(false))
    }
    func testTemplateBatchKeepsValidDocumentsAndDiagnostics() throws {
        let json = #"{"templates":[{"id":"0:1","filename":"bots.yaml","document":1,"defaults":{"profile":{"name":"Alpha"}},"diagnostics":[],"warnings":[]},{"id":"0:2","filename":"bots.yaml","document":2,"diagnostics":[{"path":"profile.name","message":"Required","line":8,"column":3}],"warnings":[]}]}"#
        let batch = try JSONDecoder().decode(BotTemplateBatch.self, from: Data(json.utf8))
        XCTAssertEqual(batch.templates.count, 2)
        XCTAssertEqual(batch.templates[0].preview?.name, "Alpha")
        XCTAssertNil(batch.templates[1].preview)
        XCTAssertEqual(batch.templates[1].diagnostics.first?.description, "profile.name (line 8): Required")
    }
    func testLiveSupportsAzureRealtimeCaptionsAndSettings() throws {
        let json = #"{"provider":"azure","configured":true,"voice":"marin"}"#
        let settings = try JSONDecoder().decode(LiveSettings.self, from: Data(json.utf8))
        XCTAssertEqual(settings.provider, "azure")
        XCTAssertEqual(LiveCallDataEvent.parse(Data(#"{"type":"session.created"}"#.utf8)), .started)
        XCTAssertEqual(LiveCallDataEvent.parse(Data(#"{"type":"conversation.item.input_audio_transcription.completed","transcript":"hello"}"#.utf8)), .inputTranscript("hello"))
        XCTAssertEqual(LiveCallDataEvent.parse(Data(#"{"type":"response.audio_transcript.delta","delta":"hi"}"#.utf8)), .outputTranscript("hi"))
    }
    func testDeviceSignInRefusesUntrustedLinksAndMalformedCodes() throws {
        func state(_ url: String, _ code: String) throws -> ProviderSignIn {
            try JSONDecoder().decode(ProviderSignIn.self, from: JSONSerialization.data(withJSONObject: ["phase": "waiting", "authorizationUrl": url, "userCode": code]))
        }
        XCTAssertNotNil(try state("https://github.com/login/device", "ABCD-1234").validatedURL(provider: "copilot"))
        XCTAssertNil(try state("https://github.com.evil.test/login/device", "ABCD-1234").validatedURL(provider: "copilot"))
        XCTAssertNil(try state("https://github.com/login/device?token=secret", "ABCD-1234").validatedURL(provider: "copilot"))
        XCTAssertNil(try state("https://github.com/login/device", "invalid").validatedURL(provider: "copilot"))
    }
    func testImportedRoutinesArePausedUnlessExplicitlyEnabled() throws {
        let json = #"{"defaults":{"profile":{},"routines":[{"name":"Review","enabled":true}]},"warnings":[]}"#
        let preview = try JSONDecoder().decode(BotTemplatePreview.self, from: Data(json.utf8))
        let paused = preview.choosingRoutines(enabled: false)
        XCTAssertNotEqual(paused.defaults, preview.defaults)
        XCTAssertEqual(preview.choosingRoutines(enabled: true).defaults, preview.defaults)
    }
    func testForkDeepLinksAndLegacyQRRemainAccepted() throws {
        let invite = try XCTUnwrap(URL(string: "copilotbot://pair?address=127.0.0.1:8810&code=123456"))
        XCTAssertNotNil(PairingInvite.parse(invite))
        XCTAssertEqual(CompanionDeepLink.parse(URL(string: "copilotbot://chat/thread-1")!), .chat(threadId: "thread-1"))
    }
    func testLearningChecksRejectAmbiguousInput() throws {
        XCTAssertEqual(try LearningChecks.parse("includes:hello\nexcludes:bad\ntool:Read").count, 3)
        XCTAssertThrowsError(try LearningChecks.parse("hello"))
        XCTAssertThrowsError(try LearningChecks.parse("includes:  "))
    }
    func testRealServerTemplateAndResourceRoundTrip() async throws {
        guard let raw = ProcessInfo.processInfo.environment["COPILOTBOT_IOS_TEST_URL"],
              let url = URL(string: raw), url.host == "127.0.0.1", url.scheme == "http",
              let botID = ProcessInfo.processInfo.environment["COPILOTBOT_IOS_TEST_BOT"] else { throw XCTSkip("Needs the isolated CopilotBot fixture server.") }
        let client = CompanionClient(connection: Connection(name: "Isolated test server", host: url.host!, port: url.port!), token: nil)
        let initial = try await client.resources(botID: botID)
        XCTAssertEqual(initial.catalog.mcpServers.count, 200)
        let policy = ResourceAccess(skills: [], mcpServers: ["mcp-199"])
        let saved = try await client.saveResources(policy, botID: botID)
        XCTAssertEqual(saved.policy, policy)
        let reloaded = try await client.resources(botID: botID)
        XCTAssertEqual(reloaded.policy, policy)
        let file = try await client.exportTemplate(botID: botID)
        let preview = try await client.previewTemplate(file.yaml)
        let newBot = try await client.createFromTemplate(preview)
        XCTAssertNotEqual(newBot.id, botID)
        let imported = try await client.resources(botID: newBot.id)
        XCTAssertEqual(imported.policy, policy)
        let learning = try await client.learning(botID: newBot.id)
        XCTAssertEqual(learning.candidates.count, 0)
        let libraryTemplate = try await client.previewTemplate("""
        format: copilotbot/bot
        version: 1
        profile:
          name: Native library import
          approvalMode: ask
        skills: [mobile-test]
        resources:
          skills: [mobile-test]
          mcpServers: []
        """)
        let libraryBot = try await client.createFromTemplate(libraryTemplate)
        let libraryExport = try await client.exportTemplate(botID: libraryBot.id)
        let libraryRoundTrip = try await client.previewTemplate(libraryExport.yaml)
        XCTAssertEqual(libraryRoundTrip.defaults.object["librarySkills"], .array([.string("mobile-test")]))
        let config = try await client.setVoiceProvider(.azure)
        XCTAssertEqual(config.voiceProvider, .azure)
    }
}
