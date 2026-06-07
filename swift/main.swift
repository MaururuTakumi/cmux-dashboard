import AppKit
import Foundation
import WebKit
import Darwin

let appName = "cmux Dashboard"
let host = "127.0.0.1"
let defaultPort = Int(ProcessInfo.processInfo.environment["CMUX_DASH_PORT"] ?? "7799") ?? 7799

struct ServerSession {
    let port: Int
    let startedByApp: Bool
    let process: Process?
}

enum StartupError: Error, CustomStringConvertible {
    case noAvailablePort(Int)
    case projectDirNotFound
    case nodeNotFound
    case launchFailed(String)
    case notReady(Int)
    case smokeExpectedStartButReused(Int)

    var description: String {
        switch self {
        case .noAvailablePort(let base):
            return "No available local port found near \(base)."
        case .projectDirNotFound:
            return "Could not find the cmux-dashboard project directory. Set CMUX_DASHBOARD_DIR to the directory that contains server.js."
        case .nodeNotFound:
            return "Could not find a node executable. Install Node.js or set NODE_BIN to an executable path."
        case .launchFailed(let message):
            return "Could not launch node server: \(message)"
        case .notReady(let port):
            return "Node server started, but /api/state did not become ready on port \(port)."
        case .smokeExpectedStartButReused(let port):
            return "Smoke test expected to start a server, but an existing /api/state responded on port \(port)."
        }
    }
}

func url(for port: Int, path: String = "/") -> URL {
    URL(string: "http://\(host):\(port)\(path)")!
}

func httpStatus(port: Int, path: String = "/api/state", timeout: TimeInterval = 3.0) -> Int? {
    var request = URLRequest(url: url(for: port, path: path))
    request.httpMethod = "GET"
    request.timeoutInterval = timeout

    let semaphore = DispatchSemaphore(value: 0)
    var status: Int?
    let task = URLSession.shared.dataTask(with: request) { _, response, _ in
        status = (response as? HTTPURLResponse)?.statusCode
        semaphore.signal()
    }
    task.resume()

    if semaphore.wait(timeout: .now() + timeout + 0.2) == .timedOut {
        task.cancel()
        return nil
    }
    return status
}

func isServerHealthy(port: Int) -> Bool {
    httpStatus(port: port) == 200
}

func isPortAvailable(_ port: Int) -> Bool {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    if fd < 0 {
        return false
    }
    defer { close(fd) }

    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = in_port_t(port).bigEndian
    address.sin_addr = in_addr(s_addr: inet_addr(host))

    var bindAddress = address
    let result = withUnsafePointer(to: &bindAddress) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
        }
    }
    return result == 0
}

func firstAvailablePort(startingAt base: Int) -> Int? {
    if isPortAvailable(base) {
        return base
    }
    for port in (base + 1)..<(base + 200) {
        if isPortAvailable(port) {
            return port
        }
    }
    return nil
}

func executablePath(_ path: String) -> String? {
    FileManager.default.isExecutableFile(atPath: path) ? path : nil
}

func resolveNode() -> String? {
    if let override = ProcessInfo.processInfo.environment["NODE_BIN"], let path = executablePath(override) {
        return path
    }

    let preferred = [
        "/opt/homebrew/bin/node",
        "/opt/homebrew/opt/node@22/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ]
    for candidate in preferred {
        if let path = executablePath(candidate) {
            return path
        }
    }

    let pathValue = ProcessInfo.processInfo.environment["PATH"] ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    for directory in pathValue.split(separator: ":") {
        let candidate = "\(directory)/node"
        if let path = executablePath(candidate) {
            return path
        }
    }

    return nil
}

func isProjectDir(_ path: String) -> Bool {
    FileManager.default.isReadableFile(atPath: URL(fileURLWithPath: path).appendingPathComponent("server.js").path)
}

func trimmedFileContents(_ url: URL) -> String? {
    guard let contents = try? String(contentsOf: url, encoding: .utf8) else {
        return nil
    }
    let trimmed = contents.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
}

func resolveProjectDir() -> String? {
    let envKeys = ["CMUX_DASHBOARD_DIR", "CMUX_DASH_PROJECT_DIR"]
    for key in envKeys {
        if let value = ProcessInfo.processInfo.environment[key], !value.isEmpty, isProjectDir(value) {
            return value
        }
    }

    var candidates: [String] = []

    if let resourceURL = Bundle.main.resourceURL?.appendingPathComponent("project-path.txt"),
       let resourcePath = trimmedFileContents(resourceURL) {
        candidates.append(resourcePath)
    }

    let bundleURL = Bundle.main.bundleURL
    candidates.append(bundleURL.deletingLastPathComponent().path)
    candidates.append(bundleURL.deletingLastPathComponent().deletingLastPathComponent().path)
    candidates.append(FileManager.default.currentDirectoryPath)
    candidates.append(FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("cmux-dashboard").path)

    for candidate in candidates {
        if isProjectDir(candidate) {
            return candidate
        }
    }

    return nil
}

func openLogHandle(projectDir: String) -> FileHandle? {
    let logURL = URL(fileURLWithPath: projectDir).appendingPathComponent(".server.log")
    if !FileManager.default.fileExists(atPath: logURL.path) {
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
    }
    guard let handle = try? FileHandle(forWritingTo: logURL) else {
        return nil
    }
    do {
        try handle.seekToEnd()
    } catch {
        return nil
    }
    return handle
}

func startNodeServer(port: Int, projectDir: String, nodePath: String) throws -> Process {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: nodePath)
    process.arguments = ["server.js"]
    process.currentDirectoryURL = URL(fileURLWithPath: projectDir)

    var environment = ProcessInfo.processInfo.environment
    environment["CMUX_DASH_PORT"] = "\(port)"
    environment["CMUX_DASH_HOST"] = host
    process.environment = environment

    if let logHandle = openLogHandle(projectDir: projectDir) {
        process.standardOutput = logHandle
        process.standardError = logHandle
    }
    process.standardInput = FileHandle.nullDevice

    do {
        try process.run()
    } catch {
        throw StartupError.launchFailed(error.localizedDescription)
    }
    return process
}

func waitForReady(port: Int, timeout: TimeInterval = 10.0) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if isServerHealthy(port: port) {
            return true
        }
        Thread.sleep(forTimeInterval: 0.25)
    }
    return false
}

func prepareServer(defaultPort: Int, requireStartForSmoke: Bool = false) throws -> ServerSession {
    if isServerHealthy(port: defaultPort) {
        if requireStartForSmoke {
            throw StartupError.smokeExpectedStartButReused(defaultPort)
        }
        return ServerSession(port: defaultPort, startedByApp: false, process: nil)
    }

    guard let port = firstAvailablePort(startingAt: defaultPort) else {
        throw StartupError.noAvailablePort(defaultPort)
    }
    guard let projectDir = resolveProjectDir() else {
        throw StartupError.projectDirNotFound
    }
    guard let nodePath = resolveNode() else {
        throw StartupError.nodeNotFound
    }

    let process = try startNodeServer(port: port, projectDir: projectDir, nodePath: nodePath)
    if waitForReady(port: port) {
        return ServerSession(port: port, startedByApp: true, process: process)
    }

    stopStartedServer(process: process, port: port)
    throw StartupError.notReady(port)
}

func stopStartedServer(process: Process, port: Int, timeout: TimeInterval = 5.0) {
    guard process.isRunning else {
        return
    }

    process.terminate()
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if !process.isRunning && !isServerHealthy(port: port) {
            break
        }
        Thread.sleep(forTimeInterval: 0.1)
    }

    if process.isRunning {
        kill(process.processIdentifier, SIGKILL)
        process.waitUntilExit()
    }
}

func runSmokeServerLifecycle() -> Int32 {
    let requireStart = ProcessInfo.processInfo.environment["CMUX_DASH_SMOKE_REQUIRE_START"] == "1"
    do {
        let session = try prepareServer(defaultPort: defaultPort, requireStartForSmoke: requireStart)
        if session.startedByApp, let process = session.process {
            print("SMOKE: started node pid \(process.processIdentifier) on http://\(host):\(session.port)")
            guard isServerHealthy(port: session.port) else {
                fputs("SMOKE: FAIL /api/state was not healthy after startup\n", stderr)
                stopStartedServer(process: process, port: session.port)
                return 1
            }
            stopStartedServer(process: process, port: session.port)
            if isServerHealthy(port: session.port) {
                fputs("SMOKE: FAIL /api/state still responds after terminating owned node\n", stderr)
                return 1
            }
            print("SMOKE: stopped owned node on port \(session.port)")
            return 0
        }

        print("SMOKE: reused existing server on http://\(host):\(session.port); no owned process to stop")
        return 0
    } catch {
        fputs("SMOKE: FAIL \(error)\n", stderr)
        return 1
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private var webView: WKWebView?
    private var serverSession: ServerSession?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        configureMenu()
        createWindow()
        showMessage(title: "Starting cmux Dashboard", body: "Preparing the local dashboard server...")

        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let session = try prepareServer(defaultPort: defaultPort)
                DispatchQueue.main.async {
                    self.serverSession = session
                    self.loadDashboard(port: session.port)
                }
            } catch {
                DispatchQueue.main.async {
                    self.showMessage(title: "cmux Dashboard could not start", body: "\(error)")
                }
            }
        }

        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if let session = serverSession, session.startedByApp, let process = session.process {
            stopStartedServer(process: process, port: session.port)
        }
        return .terminateNow
    }

    @objc func reloadDashboard(_ sender: Any?) {
        webView?.reload()
    }

    private func configureMenu() {
        let mainMenu = NSMenu(title: appName)

        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        let appMenu = NSMenu(title: appName)
        appMenuItem.submenu = appMenu
        appMenu.addItem(NSMenuItem(title: "Quit \(appName)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))

        let viewMenuItem = NSMenuItem()
        mainMenu.addItem(viewMenuItem)
        let viewMenu = NSMenu(title: "View")
        viewMenuItem.submenu = viewMenu
        let reloadItem = NSMenuItem(title: "Reload", action: #selector(reloadDashboard(_:)), keyEquivalent: "r")
        reloadItem.target = self
        viewMenu.addItem(reloadItem)

        NSApp.mainMenu = mainMenu
    }

    private func createWindow() {
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 880),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = appName
        window.center()
        window.makeKeyAndOrderFront(nil)
    }

    private func showMessage(title: String, body: String) {
        let textView = NSTextView(frame: window.contentView?.bounds ?? NSRect(x: 0, y: 0, width: 1280, height: 880))
        textView.autoresizingMask = [.width, .height]
        textView.isEditable = false
        textView.isSelectable = true
        textView.drawsBackground = true
        textView.backgroundColor = NSColor.windowBackgroundColor
        textView.textColor = NSColor.labelColor
        textView.font = NSFont.monospacedSystemFont(ofSize: 14, weight: .regular)
        textView.textContainerInset = NSSize(width: 24, height: 24)
        textView.string = "\(title)\n\n\(body)"
        window.contentView = textView
    }

    private func loadDashboard(port: Int) {
        let configuration = WKWebViewConfiguration()
        let view = WKWebView(frame: window.contentView?.bounds ?? NSRect(x: 0, y: 0, width: 1280, height: 880), configuration: configuration)
        view.autoresizingMask = [.width, .height]
        window.contentView = view
        webView = view
        view.load(URLRequest(url: url(for: port)))
    }
}

if CommandLine.arguments.contains("--smoke-server-lifecycle") {
    exit(runSmokeServerLifecycle())
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
