import XCTest

final class CopilotBotUITests: XCTestCase {
    @MainActor
    func testLargeTeamCatalogSearchSelectionAndPersistence() {
        let app = launch()
        XCTAssertTrue(app.buttons["resources-skills"].waitForExistence(timeout: 10))
        record("Team resource summary, 1000 skills and 200 MCPs", app)
        app.buttons["resources-skills"].tap()
        XCTAssertTrue(app.staticTexts["1,000 of 1,000 selected"].waitForExistence(timeout: 5))
        let search = app.searchFields.firstMatch
        search.tap(); search.typeText("skill-0999")
        let toggle = app.switches["resource-skill-0999"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        XCTAssertFalse(app.switches["resource-skill-0000"].exists)
        toggle.switches.firstMatch.exists ? toggle.switches.firstMatch.tap() : toggle.tap()
        XCTAssertTrue(app.staticTexts["999 of 1,000 selected"].exists)
        record("Filtered skill catalog", app)
        app.buttons["resource-save"].tap()
        XCTAssertTrue(app.buttons["resources-skills"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["999 of 1,000"].exists)
        app.buttons["resources-mcps"].tap()
        XCTAssertTrue(app.staticTexts["200 of 200 selected"].waitForExistence(timeout: 5))
        let mcpSearch = app.searchFields.firstMatch
        mcpSearch.tap(); mcpSearch.typeText("mcp-199")
        XCTAssertTrue(app.switches["resource-mcp-199"].waitForExistence(timeout: 5))
        record("MCP catalog search", app)
    }
    @MainActor
    func testIndividualBotShowsInheritedTeamLimits() {
        let app = launch(bot: true)
        app.buttons["resources-skills"].tap()
        XCTAssertTrue(app.staticTexts["2 of 1,000 selected"].waitForExistence(timeout: 5))
        let search = app.searchFields.firstMatch
        search.tap(); search.typeText("skill-0001")
        let toggle = app.switches["resource-skill-0001"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        XCTAssertFalse(toggle.isEnabled)
        XCTAssertTrue(app.staticTexts["Not allowed by team"].exists)
        record("Individual bot inherits team limits", app)
    }
    @MainActor
    func testNewBotOffersCreationAndFileImport() {
        let app = XCUIApplication()
        app.terminate()
        app.launchArguments = ["-store-preview", "-threads-preview", "-copilotbot-preview", "-companion.onboarding.welcomeSeen", "YES", "-companion.onboarding.notificationsSeen", "YES"]
        app.launch()
        if app.buttons["Connect computer"].waitForExistence(timeout: 2) { app.terminate(); app.launch() }
        XCTAssertTrue(app.buttons["Create"].waitForExistence(timeout: 10))
        app.buttons["Create"].tap()
        app.buttons["New bot"].tap()
        XCTAssertTrue(app.buttons["Create a new bot"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Import YAML files"].exists)
        record("New bot or YAML import", app)
    }

    @MainActor
    func testLearningRollbackRequiresConfirmationAndRefreshesState() {
        let app = XCUIApplication()
        app.terminate()
        app.launchArguments = ["-store-preview", "-threads-preview", "-copilotbot-preview", "-open-learning", "-companion.onboarding.welcomeSeen", "YES", "-companion.onboarding.notificationsSeen", "YES"]
        app.launch()
        if app.buttons["Connect computer"].waitForExistence(timeout: 2) { app.terminate(); app.launch() }
        let rollback = app.buttons["Roll back…"]
        XCTAssertTrue(rollback.waitForExistence(timeout: 10))
        record("Learning review before rollback", app)
        rollback.tap()
        XCTAssertTrue(app.buttons["Cancel"].waitForExistence(timeout: 5))
        app.buttons["Cancel"].tap()
        XCTAssertTrue(rollback.exists)
        rollback.tap()
        app.buttons["Roll back"].tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "rolled_back")).firstMatch.waitForExistence(timeout: 5))
        XCTAssertFalse(rollback.exists)
        record("Learning rollback confirmed", app)
    }

    @MainActor
    private func launch(bot: Bool = false) -> XCUIApplication {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.terminate()
        app.launchArguments = ["-store-preview", "-threads-preview", "-copilotbot-preview", "-open-resources", "-companion.onboarding.welcomeSeen", "YES", "-companion.onboarding.notificationsSeen", "YES", "-AppleLanguages", "(en)", "-AppleLocale", "en_US"] + (bot ? ["-bot-resources"] : [])
        app.launch()
        if app.buttons["Connect computer"].waitForExistence(timeout: 2) { app.terminate(); app.launch() }
        return app
    }
    @MainActor private func record(_ name: String, _ app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot()); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
}
