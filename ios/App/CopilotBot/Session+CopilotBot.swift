import CompanionCore

extension Session {
    func createCopilotBot(template: BotTemplatePreview?) async -> Bot? {
        guard let template else { return await createBot() }
        guard let client else { return nil }
        let id = connection?.id
        do {
            let bot = try await client.createFromTemplate(template)
            guard connection?.id == id else { return nil }
            await refresh()
            return bot
        } catch { actionError = error.localizedDescription; return nil }
    }
}
