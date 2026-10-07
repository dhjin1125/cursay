import ApplicationServices
import Cocoa
import Foundation
import Network
import QuartzCore

private let helperVersion = "0.6.19"
private let maximumRequestAgeMs: Double = 5_000
private let refinementPasteEventTag: Int64 = 0x435552534159
private var functionKeyMonitorAvailable = false
private let excludedBundleIds = Set([
    "local.minkyu.CodexVoiceControl",
    "local.minkyu.CodexVoiceActionHelper",
])

private struct Request: Decodable {
    let id: String
    let type: String
    let text: String?
    let expectedText: String?
    let key: String?
    let modifiers: [String]?
    let targetBundleIds: [String]?
    let targetContextId: String?
    let targetMode: String?
    let timestampMs: Double?
}

private struct Response: Encodable {
    let id: String
    let ok: Bool
    let trusted: Bool?
    let version: String?
    let fnMonitorAvailable: Bool?
    let error: String?
    let text: String?
    let targetBundleId: String?
    let targetContextId: String?
    let targetDisplayName: String?
    let targetBundlePath: String?
    let targetBinding: TargetBindingState?

    init(
        id: String,
        ok: Bool,
        trusted: Bool? = nil,
        version: String? = nil,
        fnMonitorAvailable: Bool? = nil,
        error: String? = nil,
        text: String? = nil,
        targetBundleId: String? = nil,
        targetContextId: String? = nil,
        targetDisplayName: String? = nil,
        targetBundlePath: String? = nil,
        targetBinding: TargetBindingState? = nil
    ) {
        self.id = id
        self.ok = ok
        self.trusted = trusted
        self.version = version
        self.fnMonitorAvailable = fnMonitorAvailable
        self.error = error
        self.text = text
        self.targetBundleId = targetBundleId
        self.targetContextId = targetContextId
        self.targetDisplayName = targetDisplayName
        self.targetBundlePath = targetBundlePath
        self.targetBinding = targetBinding
    }
}

private enum TargetBindingState: String, Encodable {
    case foreground
    case background
    case rebinding
    case invalid
}

private enum TargetBindingInvalidReason: String, Encodable {
    case processTerminated = "process-terminated"
    case inputUnavailable = "input-unavailable"
}

private struct FunctionKeyBridgeEvent: Encodable {
    let type: String
    let state: String
    let targetMode: String
    let timestampMs: Double
}

private struct TargetBindingBridgeEvent: Encodable {
    let type: String
    let targetContextId: String
    let binding: TargetBindingState
    let reason: TargetBindingInvalidReason?
    let timestampMs: Double
}

private struct TargetBindingSnapshot {
    let targetContextId: String
    let binding: TargetBindingState
    let reason: TargetBindingInvalidReason?
}

private func encodedLine<T: Encodable>(_ value: T) -> Data? {
    guard var data = try? JSONEncoder().encode(value) else { return nil }
    data.append(0x0A)
    return data
}

private func sendToStdout(_ response: Response) {
    guard let data = encodedLine(response) else { return }
    FileHandle.standardOutput.write(data)
}

private func trusted(prompt: Bool) -> Bool {
    if !prompt {
        return AXIsProcessTrusted()
    }
    let option = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
    return AXIsProcessTrustedWithOptions([option: true] as CFDictionary)
}

private func validateFreshness(_ timestampMs: Double?) -> String? {
    guard let timestampMs else { return "Missing request timestamp." }
    let age = abs(Date().timeIntervalSince1970 * 1_000 - timestampMs)
    return age <= maximumRequestAgeMs ? nil : "Expired action request."
}

private func validateForegroundTarget(_ bundleIds: [String]?) -> String? {
    guard let bundleIds, !bundleIds.isEmpty else { return "Missing target allowlist." }
    guard let frontmost = NSWorkspace.shared.frontmostApplication?.bundleIdentifier else {
        return "No frontmost application."
    }
    return bundleIds.contains(frontmost) ? nil : "Frontmost application is not allowlisted."
}

private func attributeIsSettable(_ element: AXUIElement, _ attribute: CFString) -> Bool {
    var settable = DarwinBoolean(false)
    return AXUIElementIsAttributeSettable(element, attribute, &settable) == .success &&
        settable.boolValue
}

private func elementProcessId(_ element: AXUIElement) -> pid_t? {
    var pid: pid_t = 0
    return AXUIElementGetPid(element, &pid) == .success ? pid : nil
}

private func isEditableElement(_ element: AXUIElement, expectedPid: pid_t? = nil) -> Bool {
    if let expectedPid, elementProcessId(element) != expectedPid { return false }
    var roleValue: CFTypeRef?
    guard AXUIElementCopyAttributeValue(
        element,
        kAXRoleAttribute as CFString,
        &roleValue
    ) == .success else {
        return false
    }
    let role = roleValue as? String
    let editableRoles = Set(["AXTextArea", "AXTextField", "AXSearchField", "AXComboBox"])
    return editableRoles.contains(role ?? "") ||
        attributeIsSettable(element, kAXSelectedTextRangeAttribute as CFString)
}

private func focusedEditableElement(in root: AXUIElement, expectedPid: pid_t? = nil) -> AXUIElement? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(
        root,
        kAXFocusedUIElementAttribute as CFString,
        &value
    ) == .success, let value else {
        return nil
    }

    let element = unsafeBitCast(value, to: AXUIElement.self)
    return isEditableElement(element, expectedPid: expectedPid) ? element : nil
}

private func focusedEditableElement() -> AXUIElement? {
    focusedEditableElement(in: AXUIElementCreateSystemWide())
}

private func waitForFocusedEditableElement(
    in root: AXUIElement,
    expectedPid: pid_t? = nil,
    attempts: Int = 6
) -> AXUIElement? {
    for attempt in 0..<attempts {
        if let element = focusedEditableElement(in: root, expectedPid: expectedPid) {
            return element
        }
        if attempt + 1 < attempts {
            usleep(5_000)
        }
    }
    return nil
}

private func editableTextValue(_ element: AXUIElement) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(
        element,
        kAXValueAttribute as CFString,
        &value
    ) == .success else {
        return nil
    }
    return value as? String
}

private func editableSelectedTextRange(_ element: AXUIElement) -> CFRange? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(
        element,
        kAXSelectedTextRangeAttribute as CFString,
        &value
    ) == .success, let value,
          CFGetTypeID(value) == AXValueGetTypeID() else {
        return nil
    }
    let rangeValue = unsafeBitCast(value, to: AXValue.self)
    guard AXValueGetType(rangeValue) == .cfRange else { return nil }
    var range = CFRange()
    return AXValueGetValue(rangeValue, .cfRange, &range) ? range : nil
}

private func waitForTextMutation(
    from previousValue: String?,
    previousRange: CFRange?,
    element: AXUIElement,
    attempts: Int = 40
) -> Bool {
    guard previousValue != nil || previousRange != nil else { return true }
    for _ in 0..<attempts {
        usleep(5_000)
        if let previousValue,
           let currentValue = editableTextValue(element),
           currentValue != previousValue {
            return true
        }
        if let previousRange,
           let currentRange = editableSelectedTextRange(element),
           currentRange.location != previousRange.location ||
            currentRange.length != previousRange.length {
            return true
        }
    }
    return false
}

private func waitForTextValueChange(
    from previous: String,
    element: AXUIElement,
    attempts: Int = 40
) -> Bool {
    for _ in 0..<attempts {
        usleep(5_000)
        if let current = editableTextValue(element), current != previous {
            return true
        }
    }
    return false
}

private func focusForBackgroundEditing(_ element: AXUIElement) -> Bool {
    guard attributeIsSettable(element, kAXFocusedAttribute as CFString) else {
        return false
    }
    let result = AXUIElementSetAttributeValue(
        element,
        kAXFocusedAttribute as CFString,
        kCFBooleanTrue
    ) == .success
    if result {
        // Chromium turns AXFocused into an asynchronous kFocus edit action.
        usleep(5_000)
    }
    return result
}

private func elementReportsFocused(_ element: AXUIElement) -> Bool {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(
        element,
        kAXFocusedAttribute as CFString,
        &value
    ) == .success else {
        return false
    }
    return (value as? Bool) == true
}

private func replaceSelectedTextUsingAccessibility(
    _ text: String,
    element: AXUIElement,
    previousValue: String?,
    previousRange: CFRange?
) -> Bool {
    guard !text.isEmpty,
          attributeIsSettable(element, kAXSelectedTextAttribute as CFString) else {
        return false
    }
    let accepted = AXUIElementSetAttributeValue(
        element,
        kAXSelectedTextAttribute as CFString,
        text as CFString
    ) == .success
    guard accepted else { return false }
    return waitForTextMutation(
        from: previousValue,
        previousRange: previousRange,
        element: element
    )
}

private func replaceAllTextUsingAccessibility(
    _ text: String,
    element: AXUIElement,
    expectedText: String? = nil
) -> Bool {
    guard let current = editableTextValue(element),
          expectedText == nil || current == expectedText,
          attributeIsSettable(element, kAXSelectedTextRangeAttribute as CFString),
          attributeIsSettable(element, kAXSelectedTextAttribute as CFString) else {
        return false
    }
    if text == current { return true }
    let previousRange = editableSelectedTextRange(element)
    var range = CFRange(location: 0, length: (current as NSString).length)
    guard let rangeValue = AXValueCreate(.cfRange, &range),
          AXUIElementSetAttributeValue(
            element,
            kAXSelectedTextRangeAttribute as CFString,
            rangeValue
          ) == .success else {
        return false
    }
    usleep(5_000)
    guard editableTextValue(element) == current else {
        if var previousRange, let value = AXValueCreate(.cfRange, &previousRange) {
            _ = AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, value)
        }
        return false
    }
    let accepted = AXUIElementSetAttributeValue(
        element,
        kAXSelectedTextAttribute as CFString,
        text as CFString
    ) == .success
    guard accepted else {
        if var previousRange, let value = AXValueCreate(.cfRange, &previousRange) {
            _ = AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, value)
        }
        return false
    }
    for _ in 0..<40 {
        usleep(5_000)
        if editableTextValue(element) == text { return true }
    }
    return false
}

private func postUnicodeEvent(
    _ text: String,
    source: CGEventSource,
    toPid pid: pid_t?
) -> Bool {
    let units = Array(text.utf16)
    guard !units.isEmpty,
          let keyDown = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
          let keyUp = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else {
        return false
    }

    units.withUnsafeBufferPointer { buffer in
        guard let baseAddress = buffer.baseAddress else { return }
        keyDown.keyboardSetUnicodeString(stringLength: units.count, unicodeString: baseAddress)
        keyUp.keyboardSetUnicodeString(stringLength: units.count, unicodeString: baseAddress)
    }
    if let pid {
        keyDown.postToPid(pid)
        keyUp.postToPid(pid)
    } else {
        keyDown.post(tap: .cghidEventTap)
        keyUp.post(tap: .cghidEventTap)
    }
    return true
}

private func postUnicode(_ text: String, toPid pid: pid_t? = nil) -> Bool {
    guard !text.isEmpty,
          let source = CGEventSource(stateID: .hidSystemState) else {
        return false
    }

    guard let pid else {
        // This is the original, known-good foreground path.
        return postUnicodeEvent(text, source: source, toPid: nil)
    }

    // Process-targeted Quartz delivery is a keyboard-event stream, not a text
    // insertion API. Electron can consume only the first grapheme when a whole
    // sentence is attached to one background event. Give every grapheme its own
    // key-down/up pair and a small queueing gap so the inactive renderer observes
    // the same ordered input sequence as foreground typing.
    let graphemes = text.map { String($0) }
    for (index, grapheme) in graphemes.enumerated() {
        guard postUnicodeEvent(grapheme, source: source, toPid: pid) else {
            return false
        }
        if index + 1 < graphemes.count {
            usleep(1_000)
        }
    }
    return true
}

private func postHotkey(key: String, modifiers: [String], toPid pid: pid_t? = nil) -> Bool {
    let keyCodes: [String: CGKeyCode] = [
        "return": 36,
        "escape": 53,
        "tab": 48,
        "space": 49,
    ]
    guard let code = keyCodes[key],
          let source = CGEventSource(stateID: .hidSystemState),
          let keyDown = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
          let keyUp = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) else {
        return false
    }

    var flags: CGEventFlags = []
    for modifier in modifiers {
        switch modifier {
        case "command": flags.insert(.maskCommand)
        case "option": flags.insert(.maskAlternate)
        case "control": flags.insert(.maskControl)
        case "shift": flags.insert(.maskShift)
        default: break
        }
    }
    keyDown.flags = flags
    keyUp.flags = flags
    if let pid {
        keyDown.postToPid(pid)
        keyUp.postToPid(pid)
    } else {
        keyDown.post(tap: .cghidEventTap)
        keyUp.post(tap: .cghidEventTap)
    }
    return true
}

private struct EditableElementRefresh {
    let element: AXUIElement
    let value: String?
}

private final class CapturedTarget {
    let id = UUID().uuidString.lowercased()
    let bundleId: String
    let pid: pid_t
    let displayName: String
    let bundlePath: String?
    let frozen: Bool
    private let runningApplication: NSRunningApplication
    private let applicationElement: AXUIElement
    private var editableElement: AXUIElement
    private var pendingElementRefresh: EditableElementRefresh?
    private var binding: TargetBindingState = .foreground
    private var invalidReason: TargetBindingInvalidReason?
    private var accessibilityObserver: AXObserver?
    private var workspaceObserverTokens: [NSObjectProtocol] = []
    private var rebindDeadline: DispatchWorkItem?
    private var insertionFailedDuringRebind = false
    private var onBindingChange: ((TargetBindingSnapshot) -> Void)?

    init(application: NSRunningApplication, bundleId: String, pid: pid_t, element: AXUIElement, frozen: Bool = false) {
        self.runningApplication = application
        self.bundleId = bundleId
        self.pid = pid
        self.displayName = application.localizedName ?? bundleId
        self.bundlePath = application.bundleURL?.path
        self.applicationElement = AXUIElementCreateApplication(pid)
        self.editableElement = element
        self.frozen = frozen
        _ = AXUIElementSetMessagingTimeout(applicationElement, 0.8)
        _ = AXUIElementSetMessagingTimeout(editableElement, 0.8)
    }

    var bindingState: TargetBindingState { binding }

    func startObserving(onBindingChange: @escaping (TargetBindingSnapshot) -> Void) {
        guard !frozen else { return }
        self.onBindingChange = onBindingChange
        installAccessibilityObserver()

        let center = NSWorkspace.shared.notificationCenter
        workspaceObserverTokens.append(center.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            self?.handleWorkspaceActivation(notification)
        })
        workspaceObserverTokens.append(center.addObserver(
            forName: NSWorkspace.didDeactivateApplicationNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            self?.handleWorkspaceDeactivation(notification)
        })
        workspaceObserverTokens.append(center.addObserver(
            forName: NSWorkspace.didTerminateApplicationNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            self?.handleWorkspaceTermination(notification)
        })
    }

    func stopObserving() {
        rebindDeadline?.cancel()
        rebindDeadline = nil
        let center = NSWorkspace.shared.notificationCenter
        for token in workspaceObserverTokens {
            center.removeObserver(token)
        }
        workspaceObserverTokens.removeAll()
        if let accessibilityObserver {
            AXObserverRemoveNotification(
                accessibilityObserver,
                applicationElement,
                kAXFocusedUIElementChangedNotification as CFString
            )
            CFRunLoopRemoveSource(
                CFRunLoopGetMain(),
                AXObserverGetRunLoopSource(accessibilityObserver),
                .commonModes
            )
        }
        accessibilityObserver = nil
        onBindingChange = nil
    }

    private func installAccessibilityObserver() {
        var candidate: AXObserver?
        guard AXObserverCreate(
            pid,
            CapturedTarget.accessibilityCallback,
            &candidate
        ) == .success, let candidate else {
            return
        }
        guard AXObserverAddNotification(
            candidate,
            applicationElement,
            kAXFocusedUIElementChangedNotification as CFString,
            Unmanaged.passUnretained(self).toOpaque()
        ) == .success else {
            return
        }
        accessibilityObserver = candidate
        CFRunLoopAddSource(
            CFRunLoopGetMain(),
            AXObserverGetRunLoopSource(candidate),
            .commonModes
        )
    }

    private static let accessibilityCallback: AXObserverCallback = {
        _, _, _, reference in
        guard let reference else { return }
        let target = Unmanaged<CapturedTarget>
            .fromOpaque(reference)
            .takeUnretainedValue()
        target.handleAccessibilityFocusChange()
    }

    private func application(from notification: Notification) -> NSRunningApplication? {
        notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
    }

    private func isCapturedApplication(_ application: NSRunningApplication) -> Bool {
        application.isEqual(runningApplication)
    }

    private func isTargetFrontmost() -> Bool {
        guard let frontmost = NSWorkspace.shared.frontmostApplication else { return false }
        return frontmost.isEqual(runningApplication)
    }

    private func applicationIsValid() -> Bool {
        !runningApplication.isTerminated && runningApplication.bundleIdentifier == bundleId
    }

    private func publishBindingIfChanged(
        _ next: TargetBindingState,
        reason: TargetBindingInvalidReason? = nil
    ) {
        guard binding != next || invalidReason != reason else { return }
        binding = next
        invalidReason = reason
        onBindingChange?(TargetBindingSnapshot(
            targetContextId: id,
            binding: next,
            reason: reason
        ))
    }

    private func markInvalid(_ reason: TargetBindingInvalidReason) {
        pendingElementRefresh = nil
        rebindDeadline?.cancel()
        rebindDeadline = nil
        publishBindingIfChanged(.invalid, reason: reason)
    }

    private func deferUntilTargetRecovers() {
        guard applicationIsValid() else {
            markInvalid(.processTerminated)
            return
        }
        if pendingElementRefresh != nil {
            insertionFailedDuringRebind = true
        }
        publishBindingIfChanged(.rebinding)
    }

    private func handleWorkspaceActivation(_ notification: Notification) {
        guard let application = application(from: notification), binding != .invalid else {
            return
        }
        if isCapturedApplication(application) {
            guard applicationIsValid() else {
                markInvalid(.processTerminated)
                return
            }
            if let focused = focusedEditableElement(
                in: applicationElement,
                expectedPid: pid
            ) {
                adopt(focused)
                if pendingElementRefresh != nil, refreshMatchesPending(focused) {
                    finishRebind(with: focused)
                    return
                }
                publishBindingIfChanged(
                    pendingElementRefresh == nil ? .foreground : .rebinding
                )
            } else {
                deferUntilTargetRecovers()
            }
        } else if binding == .foreground || binding == .rebinding {
            transitionToBackground()
        }
    }

    private func handleWorkspaceDeactivation(_ notification: Notification) {
        guard let application = application(from: notification),
              isCapturedApplication(application),
              binding != .invalid else {
            return
        }
        transitionToBackground()
    }

    private func handleWorkspaceTermination(_ notification: Notification) {
        guard let application = application(from: notification),
              isCapturedApplication(application) else {
            return
        }
        markInvalid(.processTerminated)
    }

    private func handleAccessibilityFocusChange() {
        guard binding != .invalid, applicationIsValid() else {
            if !applicationIsValid() { markInvalid(.processTerminated) }
            return
        }
        guard let focused = focusedEditableElement(
            in: applicationElement,
            expectedPid: pid
        ) else {
            return
        }
        if pendingElementRefresh != nil, refreshMatchesPending(focused) {
            finishRebind(with: focused)
            return
        }
        if isTargetFrontmost() {
            adopt(focused)
            publishBindingIfChanged(.foreground)
            return
        }
    }

    private func transitionToBackground() {
        guard applicationIsValid() else {
            markInvalid(.processTerminated)
            return
        }
        if let focused = focusedEditableElement(
            in: applicationElement,
            expectedPid: pid
        ) {
            adopt(focused)
        }
        guard isEditableElement(editableElement, expectedPid: pid) else {
            deferUntilTargetRecovers()
            return
        }
        publishBindingIfChanged(
            pendingElementRefresh == nil ? .background : .rebinding
        )
    }

    private func adopt(_ element: AXUIElement) {
        _ = AXUIElementSetMessagingTimeout(element, 0.8)
        editableElement = element
    }

    private func refreshMatchesPending(_ candidate: AXUIElement) -> Bool {
        guard let baseline = pendingElementRefresh else { return false }
        if !CFEqual(candidate, baseline.element) { return true }
        guard let previousValue = baseline.value,
              let currentValue = editableTextValue(candidate) else {
            return false
        }
        return currentValue != previousValue
    }

    private func finishRebind(with element: AXUIElement) {
        adopt(element)
        pendingElementRefresh = nil
        insertionFailedDuringRebind = false
        rebindDeadline?.cancel()
        rebindDeadline = nil
        publishBindingIfChanged(isTargetFrontmost() ? .foreground : .background)
    }

    private func refreshElementAfterAction(attempts: Int) -> AXUIElement? {
        guard pendingElementRefresh != nil else { return nil }
        var latestCandidate: AXUIElement?

        for attempt in 0..<attempts {
            if let candidate = focusedEditableElement(
                in: applicationElement,
                expectedPid: pid
            ) {
                latestCandidate = candidate
                if refreshMatchesPending(candidate) {
                    finishRebind(with: candidate)
                    return candidate
                }
            }
            if attempt + 1 < attempts {
                usleep(5_000)
            }
        }

        // Keep the refresh pending until a later insertion succeeds. Returning
        // the app's latest focused editor still lets editors that reuse the same
        // AX node accept text without waiting for an identity/value transition.
        if let latestCandidate {
            adopt(latestCandidate)
            return latestCandidate
        }
        return nil
    }

    func prepareForHotkey(_ key: String, element: AXUIElement) {
        guard key == "return" else { return }
        let value = editableTextValue(element)
        // Return on an already empty editor cannot submit/remount it.
        guard value?.isEmpty != true else { return }
        pendingElementRefresh = EditableElementRefresh(element: element, value: value)
        insertionFailedDuringRebind = false
        if !isTargetFrontmost() {
            publishBindingIfChanged(.rebinding)
        }
    }

    func cancelPreparedHotkey(_ key: String) {
        guard key == "return" else { return }
        pendingElementRefresh = nil
        insertionFailedDuringRebind = false
        rebindDeadline?.cancel()
        rebindDeadline = nil
        publishBindingIfChanged(isTargetFrontmost() ? .foreground : .background)
    }

    func hotkeyDidDispatch(_ key: String) {
        guard key == "return", pendingElementRefresh != nil else { return }
        // The helper response is a barrier in VoiceController's serial event
        // queue. Give Electron/Chromium time to clear or replace the submitted
        // composer before any immediately following transcript is delivered.
        _ = refreshElementAfterAction(attempts: 40)
        guard pendingElementRefresh != nil else { return }
        let deadline = DispatchWorkItem { [weak self] in
            guard let self, self.pendingElementRefresh != nil else { return }
            let candidate = self.refreshElementAfterAction(attempts: 20)
            if self.pendingElementRefresh != nil,
               !self.insertionFailedDuringRebind,
               let candidate {
                self.finishRebind(with: candidate)
            } else if self.pendingElementRefresh != nil {
                self.deferUntilTargetRecovers()
            }
        }
        rebindDeadline?.cancel()
        rebindDeadline = deadline
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0, execute: deadline)
    }

    func didInsertText(into element: AXUIElement) {
        if pendingElementRefresh != nil {
            finishRebind(with: element)
            return
        }
        adopt(element)
        publishBindingIfChanged(isTargetFrontmost() ? .foreground : .background)
    }

    func didFailInsertion() {
        deferUntilTargetRecovers()
    }

    func waitUntilFocused(_ element: AXUIElement, attempts: Int = 40) -> Bool {
        for attempt in 0..<attempts {
            if elementReportsFocused(element) {
                return true
            }
            if let focused = focusedEditableElement(
                in: applicationElement,
                expectedPid: pid
            ), CFEqual(focused, element) {
                return true
            }
            if attempt + 1 < attempts {
                usleep(5_000)
            }
        }
        return false
    }

    func resolveElement() -> AXUIElement? {
        guard binding != .invalid else { return nil }
        guard applicationIsValid() else {
            markInvalid(.processTerminated)
            return nil
        }
        if frozen {
            return isEditableElement(editableElement, expectedPid: pid) ? editableElement : nil
        }
        if isTargetFrontmost() {
            guard let focused = waitForFocusedEditableElement(
                in: applicationElement,
                expectedPid: pid
            ) else {
                deferUntilTargetRecovers()
                return nil
            }
            adopt(focused)
            if pendingElementRefresh == nil {
                publishBindingIfChanged(.foreground)
            }
            return focused
        }
        if binding == .foreground {
            transitionToBackground()
            if binding == .invalid { return nil }
        }
        if pendingElementRefresh != nil,
           let replacement = refreshElementAfterAction(attempts: 20) {
            return replacement
        }
        if isEditableElement(editableElement, expectedPid: pid) {
            return editableElement
        }
        // Once the app is backgrounded, never follow its internal focus to a
        // different control. Only the explicit Return rebinding path above may
        // replace the pinned editor.
        deferUntilTargetRecovers()
        return nil
    }

    deinit {
        stopObserving()
    }
}

private struct ResolvedTarget {
    let target: CapturedTarget?
    let element: AXUIElement?
    let error: String?
}

private final class TargetRegistry {
    private var targets: [String: CapturedTarget] = [:]
    var onBindingChange: ((TargetBindingSnapshot) -> Void)?

    func captureFrontmost(frozen: Bool = false) -> CapturedTarget? {
        guard trusted(prompt: false),
              let application = NSWorkspace.shared.frontmostApplication,
              let bundleId = application.bundleIdentifier,
              !excludedBundleIds.contains(bundleId) else {
            return nil
        }
        let pid = application.processIdentifier
        let appElement = AXUIElementCreateApplication(pid)
        _ = AXUIElementSetMessagingTimeout(appElement, 0.8)
        guard let element = waitForFocusedEditableElement(
            in: appElement,
            expectedPid: pid
        ) else {
            return nil
        }
        let captured = CapturedTarget(
            application: application,
            bundleId: bundleId,
            pid: pid,
            element: element,
            frozen: frozen
        )
        captured.startObserving { [weak self] snapshot in
            self?.onBindingChange?(snapshot)
        }
        targets[captured.id] = captured
        return captured
    }

    func resolve(contextId: String?, allowedBundleIds: [String]?) -> ResolvedTarget {
        guard let contextId, !contextId.isEmpty else {
            return ResolvedTarget(target: nil, element: nil, error: "Missing captured target context.")
        }
        guard let allowedBundleIds, !allowedBundleIds.isEmpty else {
            return ResolvedTarget(target: nil, element: nil, error: "Missing target allowlist.")
        }
        guard let target = targets[contextId] else {
            return ResolvedTarget(target: nil, element: nil, error: "Captured target has expired.")
        }
        guard allowedBundleIds.contains(target.bundleId) else {
            return ResolvedTarget(target: nil, element: nil, error: "Captured target is not allowlisted.")
        }
        guard let element = target.resolveElement() else {
            if target.bindingState == .invalid {
                target.stopObserving()
                targets.removeValue(forKey: contextId)
                return ResolvedTarget(target: nil, element: nil, error: "Captured text field is no longer available.")
            }
            return ResolvedTarget(target: target, element: nil, error: "Captured text field is temporarily unavailable.")
        }
        return ResolvedTarget(target: target, element: element, error: nil)
    }

    func release(contextId: String?) {
        guard let contextId else { return }
        targets.removeValue(forKey: contextId)?.stopObserving()
    }
}

private let targetRegistry = TargetRegistry()

private func dispatchPid(for target: CapturedTarget) -> pid_t? {
    // Preserve the original foreground typing path exactly. When the user moves
    // to another app, route the same keyboard event only to the captured process.
    // Never rewrite AXValue: controlled Electron contenteditables can reset their
    // AX selection to zero and reconcile direct value mutations out of the DOM.
    NSWorkspace.shared.frontmostApplication?.processIdentifier == target.pid
        ? nil
        : target.pid
}

private func insertTextIntoCapturedTarget(
    _ text: String,
    target: CapturedTarget,
    element: AXUIElement
) -> Bool {
    var expected: String?
    if target.frozen, let value = editableTextValue(element),
       let range = editableSelectedTextRange(element), range.location >= 0, range.length >= 0,
       range.location + range.length <= (value as NSString).length {
        expected = (value as NSString).replacingCharacters(in: NSRange(location: range.location, length: range.length), with: text)
    }
    let inserted = dispatchTextIntoCapturedTarget(text, target: target, element: element)
    guard inserted, let expected else { return inserted }
    // Refine must read the field after the renderer has applied the final keystrokes.
    for _ in 0..<200 {
        usleep(5_000)
        if editableTextValue(element) == expected { return true }
    }
    return false
}

private func dispatchTextIntoCapturedTarget(_ text: String, target: CapturedTarget, element: AXUIElement) -> Bool {
    let foregroundPid = dispatchPid(for: target)
    let focused = focusedEditableElement(in: AXUIElementCreateApplication(target.pid), expectedPid: target.pid)
    let frozenNeedsTargetedDelivery = target.frozen && !(foregroundPid == nil && focused.map { CFEqual($0, element) } == true)
    guard let backgroundPid = frozenNeedsTargetedDelivery ? target.pid : foregroundPid else {
        let inserted = postUnicode(text)
        if inserted { target.didInsertText(into: element) }
        else { target.didFailInsertion() }
        return inserted
    }

    // Chromium maps AXSelectedText writes to kReplaceSelectedText, preserving
    // its DOM/editor state and advancing the real selection. This is distinct
    // from the destructive AXValue replacement that caused the cursor-zero
    // regression. Per-grapheme process events remain a compatibility fallback.
    let previousValue = editableTextValue(element)
    let previousRange = editableSelectedTextRange(element)
    let focusRequested = focusForBackgroundEditing(element)
    if replaceSelectedTextUsingAccessibility(
        text,
        element: element,
        previousValue: previousValue,
        previousRange: previousRange
    ) {
        target.didInsertText(into: element)
        return true
    }

    // Chromium may not expose an inactive editor through the application's
    // focused-element lookup even after accepting AXFocused. Check the exact
    // element's own focus attribute as well before using the PID-scoped fallback.
    guard focusRequested, target.waitUntilFocused(element) else {
        target.didFailInsertion()
        return false
    }
    guard postUnicode(text, toPid: backgroundPid) else {
        target.didFailInsertion()
        return false
    }
    // Inactive Chromium renderers can keep AXValue and AXSelectedTextRange stale
    // even after the PID-scoped event has updated the DOM. Exact focus was
    // confirmed above, so the successful event post is the delivery boundary.
    target.didInsertText(into: element)
    return true
}

private func elementRectangle(_ element: AXUIElement) -> CGRect? {
    var positionValue: CFTypeRef?
    var sizeValue: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionValue) == .success,
          AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeValue) == .success,
          let positionValue, let sizeValue,
          CFGetTypeID(positionValue) == AXValueGetTypeID(),
          CFGetTypeID(sizeValue) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(unsafeBitCast(positionValue, to: AXValue.self), .cgPoint, &point),
          AXValueGetValue(unsafeBitCast(sizeValue, to: AXValue.self), .cgSize, &size),
          point.x.isFinite, point.y.isFinite, size.width.isFinite, size.height.isFinite,
          size.width > 0, size.height > 0 else { return nil }
    return CGRect(origin: point, size: size)
}

private func elementWindow(_ element: AXUIElement) -> AXUIElement? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXWindowAttribute as CFString, &value) == .success,
          let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return unsafeBitCast(value, to: AXUIElement.self)
}

private func refinableField(_ element: AXUIElement) -> Bool {
    var subrole: CFTypeRef?
    _ = AXUIElementCopyAttributeValue(element, kAXSubroleAttribute as CFString, &subrole)
    guard subrole as? String != "AXSecureTextField" else { return false }
    return attributeIsSettable(element, kAXSelectedTextRangeAttribute as CFString) &&
        attributeIsSettable(element, kAXSelectedTextAttribute as CFString)
}

private final class RefinementPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

private final class RefinementCover: NSView {
    private let badge = NSView()
    private let spinner = NSProgressIndicator()
    private let label = NSTextField(labelWithString: "Refining…")
    private let cancel = NSButton()
    private let sweep = CAGradientLayer()
    var onCancel: (() -> Void)?

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.cornerRadius = 9
        layer?.masksToBounds = true
        layer?.borderWidth = 1.5
        sweep.colors = [NSColor.clear.cgColor, NSColor.systemPurple.withAlphaComponent(0.13).cgColor, NSColor.clear.cgColor]
        sweep.startPoint = CGPoint(x: 0, y: 0.5)
        sweep.endPoint = CGPoint(x: 1, y: 0.5)
        layer?.addSublayer(sweep)
        badge.wantsLayer = true
        badge.layer?.cornerRadius = 14
        badge.layer?.shadowColor = NSColor.black.cgColor
        badge.layer?.shadowOpacity = 0.10
        badge.layer?.shadowRadius = 8
        addSubview(badge)
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isIndeterminate = true
        spinner.startAnimation(nil)
        label.font = .systemFont(ofSize: 12, weight: .medium)
        label.textColor = .labelColor
        label.lineBreakMode = .byClipping
        label.maximumNumberOfLines = 1
        cancel.image = NSImage(systemSymbolName: "xmark", accessibilityDescription: "Cancel refinement")
        cancel.isBordered = false
        cancel.bezelStyle = .circular
        cancel.target = self
        cancel.action = #selector(cancelPressed)
        cancel.toolTip = "Cancel refinement (Esc)"
        cancel.setAccessibilityLabel("Cancel refinement")
        badge.addSubview(spinner)
        badge.addSubview(label)
        badge.addSubview(cancel)
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("Refining input. Editing is paused.")
        updateColors()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) {}
    override func rightMouseDown(with event: NSEvent) {}
    override func otherMouseDown(with event: NSEvent) {}
    override func scrollWheel(with event: NSEvent) {}
    override func mouseDragged(with event: NSEvent) {}
    override func viewDidChangeEffectiveAppearance() { updateColors() }

    private func updateColors() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer?.backgroundColor = NSColor.windowBackgroundColor.withAlphaComponent(0.38).cgColor
            layer?.borderColor = NSColor.systemPurple.withAlphaComponent(0.55).cgColor
            badge.layer?.backgroundColor = NSColor.windowBackgroundColor.withAlphaComponent(0.97).cgColor
        }
    }

    override func layout() {
        super.layout()
        let height = min(30, bounds.height)
        let width = min(160, bounds.width)
        badge.frame = NSRect(x: (bounds.width - width) / 2, y: (bounds.height - height) / 2, width: width, height: height)
        spinner.frame = NSRect(x: 10, y: (height - 16) / 2, width: 16, height: 16)
        cancel.frame = NSRect(x: width - 28, y: (height - 22) / 2, width: 22, height: 22)
        label.frame = NSRect(x: 34, y: (height - 16) / 2, width: max(0, width - 66), height: 16)
        label.isHidden = width < 100
        sweep.frame = bounds
        let motion = CABasicAnimation(keyPath: "transform.translation.x")
        motion.fromValue = -bounds.width
        motion.toValue = bounds.width
        motion.duration = 1.8
        motion.repeatCount = .infinity
        sweep.add(motion, forKey: "refinementSweep")
    }

    @objc private func cancelPressed() { onCancel?() }
}

private final class RefinementKeyboardFilter {
    private let pid: pid_t
    private let onCancel: () -> Void
    private let stateLock = NSLock()
    private var blocked = true
    private var eventTap: CFMachPort?
    private var runLoop: CFRunLoop?
    private var thread: Thread?

    init(pid: pid_t, onCancel: @escaping () -> Void) {
        self.pid = pid
        self.onCancel = onCancel
    }

    func setBlocked(_ value: Bool) {
        stateLock.lock()
        blocked = value
        stateLock.unlock()
    }

    func start() -> Bool {
        let mask = (CGEventMask(1) << CGEventType.keyDown.rawValue) | (CGEventMask(1) << CGEventType.keyUp.rawValue)
        guard let tap = CGEvent.tapCreateForPid(pid: pid, place: .headInsertEventTap, options: .defaultTap,
            eventsOfInterest: mask, callback: { _, type, event, reference in
                guard let reference else { return Unmanaged.passUnretained(event) }
                let filter = Unmanaged<RefinementKeyboardFilter>.fromOpaque(reference).takeUnretainedValue()
                if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                    DispatchQueue.main.async { filter.onCancel() }
                    return Unmanaged.passUnretained(event)
                }
                if event.getIntegerValueField(.eventSourceUserData) == refinementPasteEventTag,
                   event.getIntegerValueField(.eventSourceUnixProcessID) == Int64(getpid()) {
                    return Unmanaged.passUnretained(event)
                }
                filter.stateLock.lock()
                let blocked = filter.blocked
                filter.stateLock.unlock()
                guard blocked else { return Unmanaged.passUnretained(event) }
                let key = event.getIntegerValueField(.keyboardEventKeycode)
                if key == 53 {
                    if type == .keyDown { DispatchQueue.main.async { filter.onCancel() } }
                    return nil
                }
                if event.flags.contains(.maskCommand), [48, 49, 4, 12, 13, 50].contains(key) {
                    return Unmanaged.passUnretained(event)
                }
                return nil
            }, userInfo: Unmanaged.passUnretained(self).toOpaque()) else { return false }
        guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
            CFMachPortInvalidate(tap)
            return false
        }
        eventTap = tap
        let ready = DispatchSemaphore(value: 0)
        let thread = Thread { [self] in
            let loop = CFRunLoopGetCurrent()
            stateLock.lock()
            runLoop = loop
            stateLock.unlock()
            CFRunLoopAddSource(loop, source, .commonModes)
            ready.signal()
            CFRunLoopRun()
            CFRunLoopRemoveSource(loop, source, .commonModes)
        }
        thread.name = "Cursay field input lock"
        self.thread = thread
        thread.start()
        guard ready.wait(timeout: .now() + 1) == .success else { stop(); return false }
        CGEvent.tapEnable(tap: tap, enable: true)
        return true
    }

    func stop() {
        if let eventTap {
            CGEvent.tapEnable(tap: eventTap, enable: false)
            CFMachPortInvalidate(eventTap)
        }
        eventTap = nil
        stateLock.lock()
        let loop = runLoop
        runLoop = nil
        stateLock.unlock()
        if let loop { CFRunLoopStop(loop) }
        thread = nil
    }
}

private final class RefinementFieldLock {
    var onCancel: ((String) -> Void)?
    private var target: CapturedTarget?
    private var element: AXUIElement?
    private var originalText: String?
    private var panel: RefinementPanel?
    private var keyboardFilter: RefinementKeyboardFilter?
    private var observer: AXObserver?
    private var timer: Timer?
    private var deadline = Date.distantPast
    private var fieldIsFocused = false
    private var windowIsFocused = false
    private var applying = false

    func begin(target: CapturedTarget, element: AXUIElement) -> (String?, String?) {
        guard self.target == nil else { return (nil, "Another field is being refined.") }
        guard target.frozen, refinableField(element), let text = editableTextValue(element) else {
            return (nil, "This input field does not support Refine. Your text was kept.")
        }
        guard text.utf16.count <= 50_000 else {
            return (nil, "The field exceeds 50,000 characters. Your text was kept.")
        }
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return (text, nil) }
        guard let frame = visibleFrame(element) else {
            return (nil, "The input field is no longer visible. Your text was kept.")
        }
        self.target = target
        self.element = element
        self.originalText = text
        deadline = Date().addingTimeInterval(40)
        guard installEventTap() else {
            end(contextId: target.id)
            return (nil, "The input field could not be locked. Your text was kept.")
        }
        installFocusObserver(pid: target.pid)
        let panel = RefinementPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.title = "Refining input"
        panel.level = .floating
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.fullScreenAuxiliary, .ignoresCycle, .transient]
        let cover = RefinementCover(frame: NSRect(origin: .zero, size: frame.size))
        cover.autoresizingMask = [.width, .height]
        cover.onCancel = { [weak self] in self?.cancel() }
        panel.contentView = cover
        self.panel = panel
        refresh()
        panel.alphaValue = 0
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.16
            panel.animator().alphaValue = 1
        }
        timer = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in self?.refresh() }
        if let timer { RunLoop.main.add(timer, forMode: .common) }
        return (text, nil)
    }

    func apply(contextId: String, expectedText: String, text: String) -> String? {
        guard let target, target.id == contextId, let element,
              originalText == expectedText, target.resolveElement() != nil,
              Date() < deadline else { return "Refinement expired. Your text was kept." }
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              text.utf16.count <= 50_000 else { return "Refine returned an invalid field." }
        guard editableTextValue(element) == expectedText else {
            return "The field changed while refining. Your changes were kept."
        }
        applying = true
        let previousRange = editableSelectedTextRange(element)
        defer {
            if editableTextValue(element) == expectedText,
               var previousRange, let value = AXValueCreate(.cfRange, &previousRange) {
                _ = AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, value)
            }
            applying = false
            end(contextId: contextId)
        }
        guard replaceAllTextUsingAccessibility(text, element: element, expectedText: expectedText) ||
              pasteReplacement(text, expectedText: expectedText, target: target, element: element) else {
            return "The refined text could not be applied to this field."
        }
        originalText = text
        return nil
    }

    private func pasteReplacement(_ text: String, expectedText: String, target: CapturedTarget, element: AXUIElement) -> Bool {
        guard editableTextValue(element) == expectedText else { return false }
        let application = AXUIElementCreateApplication(target.pid)
        let previousFocus = focusedEditableElement(in: application, expectedPid: target.pid)
        let restoreFocus = previousFocus.map { !CFEqual($0, element) } ?? false
        defer {
            if restoreFocus, let previousFocus { _ = focusForBackgroundEditing(previousFocus) }
        }
        if !target.waitUntilFocused(element, attempts: 1) {
            guard focusForBackgroundEditing(element), target.waitUntilFocused(element) else { return false }
        }
        var range = CFRange(location: 0, length: (expectedText as NSString).length)
        guard let value = AXValueCreate(.cfRange, &range),
              AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, value) == .success else { return false }
        for _ in 0..<40 {
            if let selected = editableSelectedTextRange(element), selected.location == 0, selected.length == range.length { break }
            usleep(5_000)
        }
        guard let selected = editableSelectedTextRange(element), selected.location == 0, selected.length == range.length,
              editableTextValue(element) == expectedText, target.waitUntilFocused(element, attempts: 1) else { return false }

        // A normal paste reaches controlled editors that ignore AXSelectedText.
        // Restore every clipboard representation unless the user copied something newer.
        let pasteboard = NSPasteboard.general
        let originalPasteCount = pasteboard.changeCount
        let saved = (pasteboard.pasteboardItems ?? []).map { item -> NSPasteboardItem in
            let copy = NSPasteboardItem()
            for type in item.types {
                if let data = item.data(forType: type) { copy.setData(data, forType: type) }
            }
            return copy
        }
        guard pasteboard.changeCount == originalPasteCount else { return false }
        pasteboard.clearContents()
        guard pasteboard.setString(text, forType: .string) else {
            pasteboard.writeObjects(saved)
            return false
        }
        let pasteCount = pasteboard.changeCount
        defer {
            if pasteboard.changeCount == pasteCount {
                pasteboard.clearContents()
                if !saved.isEmpty { pasteboard.writeObjects(saved) }
            }
        }
        guard let source = CGEventSource(stateID: .privateState),
              let down = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: false) else { return false }
        guard editableTextValue(element) == expectedText, target.waitUntilFocused(element, attempts: 1),
              let finalRange = editableSelectedTextRange(element), finalRange.location == 0,
              finalRange.length == range.length else { return false }
        for event in [down, up] {
            event.flags = .maskCommand
            event.setIntegerValueField(.eventSourceUserData, value: refinementPasteEventTag)
            event.postToPid(target.pid)
        }
        for _ in 0..<160 {
            usleep(5_000)
            if editableTextValue(element) == text { return true }
        }
        return false
    }

    func end(contextId: String?) {
        guard contextId == nil || contextId == target?.id else { return }
        timer?.invalidate()
        timer = nil
        if let observer {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes)
        }
        observer = nil
        keyboardFilter?.stop()
        keyboardFilter = nil
        panel?.orderOut(nil)
        panel?.close()
        panel = nil
        target = nil
        element = nil
        originalText = nil
        fieldIsFocused = false
        windowIsFocused = false
    }

    private func cancel() {
        guard let contextId = target?.id else { return }
        end(contextId: contextId)
        onCancel?(contextId)
    }

    private func visibleFrame(_ element: AXUIElement) -> NSRect? {
        guard var frame = elementRectangle(element), let primary = NSScreen.screens.first else { return nil }
        if let window = elementWindow(element), let windowFrame = elementRectangle(window) {
            frame = frame.intersection(windowFrame)
        }
        guard !frame.isNull, frame.width >= 48, frame.height >= 18 else { return nil }
        let cocoa = NSRect(x: frame.minX, y: primary.frame.maxY - frame.maxY, width: frame.width, height: frame.height)
        guard NSScreen.screens.contains(where: { $0.frame.intersects(cocoa) }) else { return nil }
        return cocoa
    }

    private func refresh() {
        guard let target, let element else { return }
        guard Date() < deadline, target.resolveElement() != nil,
              let frame = visibleFrame(element) else { cancel(); return }
        if !applying, editableTextValue(element) != originalText { cancel(); return }
        refreshFocus()
        if windowIsFocused {
            if panel?.frame != frame { panel?.setFrame(frame, display: true) }
            if panel?.isVisible != true { panel?.orderFrontRegardless() }
        } else {
            panel?.orderOut(nil)
        }
    }

    private func refreshFocus() {
        guard let target, let element else { return }
        let frontmost = NSWorkspace.shared.frontmostApplication?.processIdentifier == target.pid
        let appElement = AXUIElementCreateApplication(target.pid)
        _ = AXUIElementSetMessagingTimeout(appElement, 0.1)
        let focused = focusedEditableElement(in: appElement, expectedPid: target.pid)
        fieldIsFocused = focused.map { CFEqual($0, element) } ?? false
        keyboardFilter?.setBlocked(fieldIsFocused)
        var focusedWindow: CFTypeRef?
        _ = AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &focusedWindow)
        if let window = elementWindow(element), let focusedWindow {
            windowIsFocused = frontmost && (fieldIsFocused || CFEqual(window, focusedWindow))
        } else {
            windowIsFocused = fieldIsFocused
        }
    }

    private func installFocusObserver(pid: pid_t) {
        var candidate: AXObserver?
        guard AXObserverCreate(pid, { _, _, _, reference in
            guard let reference else { return }
            Unmanaged<RefinementFieldLock>.fromOpaque(reference).takeUnretainedValue().refreshFocus()
        }, &candidate) == .success, let candidate else { return }
        let appElement = AXUIElementCreateApplication(pid)
        for name in [kAXFocusedUIElementChangedNotification, kAXFocusedWindowChangedNotification] {
            _ = AXObserverAddNotification(candidate, appElement, name as CFString, Unmanaged.passUnretained(self).toOpaque())
        }
        observer = candidate
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(candidate), .commonModes)
    }

    private func installEventTap() -> Bool {
        guard let target else { return false }
        let filter = RefinementKeyboardFilter(pid: target.pid) { [weak self] in self?.cancel() }
        guard filter.start() else { return false }
        keyboardFilter = filter
        return true
    }
}

private let refinementFieldLock = RefinementFieldLock()

private func handle(_ request: Request) -> Response {
    switch request.type {
    case "status":
        return Response(
            id: request.id,
            ok: true,
            trusted: trusted(prompt: false),
            version: helperVersion,
            fnMonitorAvailable: functionKeyMonitorAvailable,
            error: nil
        )
    case "requestAccessibility":
        return Response(
            id: request.id,
            ok: true,
            trusted: trusted(prompt: true),
            version: helperVersion,
            fnMonitorAvailable: functionKeyMonitorAvailable,
            error: nil
        )
    case "captureTarget", "captureRefinementTarget":
        guard trusted(prompt: false) else {
            return Response(id: request.id, ok: false, trusted: false, version: helperVersion, fnMonitorAvailable: functionKeyMonitorAvailable, error: "Accessibility permission is required.")
        }
        if let error = validateFreshness(request.timestampMs) {
            return Response(id: request.id, ok: false, trusted: true, version: helperVersion, fnMonitorAvailable: functionKeyMonitorAvailable, error: error)
        }
        guard let target = targetRegistry.captureFrontmost(frozen: request.type == "captureRefinementTarget") else {
            return Response(id: request.id, ok: false, trusted: true, version: helperVersion, fnMonitorAvailable: functionKeyMonitorAvailable, error: "The focused editable field could not be pinned.")
        }
        return Response(
            id: request.id,
            ok: true,
            trusted: true,
            version: helperVersion,
            fnMonitorAvailable: functionKeyMonitorAvailable,
            error: nil,
            targetBundleId: target.bundleId,
            targetContextId: target.id,
            targetDisplayName: target.displayName,
            targetBundlePath: target.bundlePath,
            targetBinding: target.bindingState
        )
    case "beginRefinement", "applyRefinement":
        guard trusted(prompt: false) else {
            return Response(id: request.id, ok: false, error: "Accessibility permission is required.")
        }
        if let error = validateFreshness(request.timestampMs) {
            return Response(id: request.id, ok: false, error: error)
        }
        let resolved = targetRegistry.resolve(contextId: request.targetContextId, allowedBundleIds: request.targetBundleIds)
        guard let target = resolved.target, target.frozen, let element = resolved.element else {
            return Response(id: request.id, ok: false, error: resolved.error ?? "The input field is unavailable.")
        }
        if request.type == "beginRefinement" {
            let (text, error) = refinementFieldLock.begin(target: target, element: element)
            return Response(id: request.id, ok: error == nil, error: error, text: text)
        }
        guard let text = request.text, let expected = request.expectedText else {
            return Response(id: request.id, ok: false, error: "Missing refinement text.")
        }
        let error = refinementFieldLock.apply(contextId: target.id, expectedText: expected, text: text)
        return Response(id: request.id, ok: error == nil, error: error)
    case "endRefinement":
        if let error = validateFreshness(request.timestampMs) {
            return Response(id: request.id, ok: false, error: error)
        }
        guard let contextId = request.targetContextId else {
            return Response(id: request.id, ok: false, error: "Missing refinement target.")
        }
        refinementFieldLock.end(contextId: contextId)
        return Response(id: request.id, ok: true)
    case "insertText":
        guard trusted(prompt: false) else {
            return Response(id: request.id, ok: false, trusted: false, version: helperVersion, fnMonitorAvailable: functionKeyMonitorAvailable, error: "Accessibility permission is required.")
        }
        if let error = validateFreshness(request.timestampMs) {
            return Response(id: request.id, ok: false, trusted: true, version: helperVersion, fnMonitorAvailable: functionKeyMonitorAvailable, error: error)
        }
        guard let text = request.text, !text.isEmpty, text.count <= 10_000 else {
            return Response(id: request.id, ok: false, trusted: true, version: helperVersion, fnMonitorAvailable: functionKeyMonitorAvailable, error: "Text insertion payload is invalid.")
        }
        if request.targetMode == "live" {
            guard request.targetContextId == nil, postUnicode(text) else {
                return Response(id: request.id, ok: false, trusted: true, version: helperVersion, fnMonitorAvailable: functionKeyMonitorAvailable, error: "Live text insertion failed.")
            }
            return Response(id: request.id, ok: true, trusted: true, version: helperVersion, fnMonitorAvailable: functionKeyMonitorAvailable, error: nil)
        }
        if request.targetMode == "pinned", request.targetContextId == nil {
            return Response(id: request.id, ok: false, trusted: true, version: helperVersion, fnMonitorAvailable: functionKeyMonitorAvailable, error: "Pinned target context is missing.")
        }
        if request.targetContextId != nil {
            let resolved = targetRegistry.resolve(
                contextId: request.targetContextId,
                allowedBundleIds: request.targetBundleIds
            )
            if let error = resolved.error {
                return Response(id: request.id, ok: false, trusted: true, version: helperVersion, fnMonitorAvailable: functionKeyMonitorAvailable, error: error)
            }
            guard let target = resolved.target,
                  let element = resolved.element,
                  insertTextIntoCapturedTarget(
                    text,
                    target: target,
                    element: element
                  ) else {
                return Response(id: request.id, ok: false, trusted: true, version: helperVersion, fnMonitorAvailable: functionKeyMonitorAvailable, error: "Background text insertion failed.")
            }
            return Response(id: request.id, ok: true, trusted: true, version: helperVersion, fnMonitorAvailable: functionKeyMonitorAvailable, error: nil)
        }
        guard request.targetMode == nil || request.targetMode == "configured" else {
            return Response(id: request.id, ok: false, trusted: true, version: helperVersion, fnMonitorAvailable: functionKeyMonitorAvailable, error: "Unsupported target mode.")
        }
        if let error = validateForegroundTarget(request.targetBundleIds) {
            return Response(id: request.id, ok: false, trusted: true, version: helperVersion, fnMonitorAvailable: functionKeyMonitorAvailable, error: error)
        }
        guard focusedEditableElement() != nil, postUnicode(text) else {
            return Response(id: request.id, ok: false, trusted: true, version: helperVersion, fnMonitorAvailable: functionKeyMonitorAvailable, error: "Text insertion failed.")
        }
        return Response(id: request.id, ok: true, trusted: true, version: helperVersion, fnMonitorAvailable: functionKeyMonitorAvailable, error: nil)
    case "readText":
        guard trusted(prompt: false) else {
            return Response(id: request.id, ok: false, trusted: false, version: helperVersion, fnMonitorAvailable: functionKeyMonitorAvailable, error: "Accessibility permission is required.")
        }
        if let error = validateFreshness(request.timestampMs) {
            return Response(id: request.id, ok: false, trusted: true, version: helperVersion, fnMonitorAvailable: functionKeyMonitorAvailable, error: error)
        }
        let resolved = targetRegistry.resolve(
            contextId: request.targetContextId,
            allowedBundleIds: request.targetBundleIds
        )
        if let error = resolved.error {
            return Response(id: request.id, ok: false, trusted: true, version: helperVersion, fnMonitorAvailable: functionKeyMonitorAvailable, error: error)
        }
        guard let element = resolved.element,
              let text = editableTextValue(element) else {
            return Response(id: request.id, ok: false, trusted: true, version: helperVersion, fnMonitorAvailable: functionKeyMonitorAvailable, error: "Target text could not be read.")
        }
        return Response(id: request.id, ok: true, trusted: true, version: helperVersion, fnMonitorAvailable: functionKeyMonitorAvailable, error: nil, text: text)
    case "replaceText":
        guard trusted(prompt: false) else {
            return Response(id: request.id, ok: false, trusted: false, version: helperVersion, fnMonitorAvailable: functionKeyMonitorAvailable, error: "Accessibility permission is required.")
        }
        if let error = validateFreshness(request.timestampMs) {
            return Response(id: request.id, ok: false, trusted: true, version: helperVersion, fnMonitorAvailable: functionKeyMonitorAvailable, error: error)
        }
        guard let text = request.text, text.count <= 10_000 else {
            return Response(id: request.id, ok: false, trusted: true, version: helperVersion, fnMonitorAvailable: functionKeyMonitorAvailable, error: "Text replacement payload is invalid.")
        }
        let resolved = targetRegistry.resolve(
            contextId: request.targetContextId,
            allowedBundleIds: request.targetBundleIds
        )
        if let error = resolved.error {
            return Response(id: request.id, ok: false, trusted: true, version: helperVersion, fnMonitorAvailable: functionKeyMonitorAvailable, error: error)
        }
        guard let target = resolved.target,
              let element = resolved.element else {
            return Response(id: request.id, ok: false, trusted: true, version: helperVersion, fnMonitorAvailable: functionKeyMonitorAvailable, error: "Target text could not be replaced.")
        }
        if dispatchPid(for: target) != nil {
            _ = focusForBackgroundEditing(element)
        }
        guard replaceAllTextUsingAccessibility(text, element: element) else {
            return Response(id: request.id, ok: false, trusted: true, version: helperVersion, fnMonitorAvailable: functionKeyMonitorAvailable, error: "Target text could not be replaced.")
        }
        target.didInsertText(into: element)
        return Response(id: request.id, ok: true, trusted: true, version: helperVersion, fnMonitorAvailable: functionKeyMonitorAvailable, error: nil)
    case "hotkey":
        guard trusted(prompt: false) else {
            return Response(id: request.id, ok: false, trusted: false, version: helperVersion, fnMonitorAvailable: functionKeyMonitorAvailable, error: "Accessibility permission is required.")
        }
        if let error = validateFreshness(request.timestampMs) {
            return Response(id: request.id, ok: false, trusted: true, version: helperVersion, fnMonitorAvailable: functionKeyMonitorAvailable, error: error)
        }
        guard let key = request.key else {
            return Response(id: request.id, ok: false, trusted: true, version: helperVersion, fnMonitorAvailable: functionKeyMonitorAvailable, error: "Hotkey dispatch failed.")
        }
        if request.targetMode == "live" {
            guard request.targetContextId == nil,
                  postHotkey(key: key, modifiers: request.modifiers ?? []) else {
                return Response(id: request.id, ok: false, trusted: true, version: helperVersion, fnMonitorAvailable: functionKeyMonitorAvailable, error: "Live hotkey dispatch failed.")
            }
            return Response(id: request.id, ok: true, trusted: true, version: helperVersion, fnMonitorAvailable: functionKeyMonitorAvailable, error: nil)
        }
        if request.targetMode == "pinned", request.targetContextId == nil {
            return Response(id: request.id, ok: false, trusted: true, version: helperVersion, fnMonitorAvailable: functionKeyMonitorAvailable, error: "Pinned target context is missing.")
        }
        if request.targetContextId != nil {
            let resolved = targetRegistry.resolve(
                contextId: request.targetContextId,
                allowedBundleIds: request.targetBundleIds
            )
            if let error = resolved.error {
                return Response(id: request.id, ok: false, trusted: true, version: helperVersion, fnMonitorAvailable: functionKeyMonitorAvailable, error: error)
            }
            guard let target = resolved.target,
                  let element = resolved.element else {
                return Response(id: request.id, ok: false, trusted: true, version: helperVersion, fnMonitorAvailable: functionKeyMonitorAvailable, error: "Background hotkey dispatch failed.")
            }
            let destinationPid = dispatchPid(for: target)
            if destinationPid != nil,
               (!focusForBackgroundEditing(element) || !target.waitUntilFocused(element)) {
                target.didFailInsertion()
                return Response(id: request.id, ok: false, trusted: true, version: helperVersion, fnMonitorAvailable: functionKeyMonitorAvailable, error: "Background hotkey target is temporarily unavailable.")
            }
            target.prepareForHotkey(key, element: element)
            guard postHotkey(
                key: key,
                modifiers: request.modifiers ?? [],
                toPid: destinationPid
            ) else {
                target.cancelPreparedHotkey(key)
                return Response(id: request.id, ok: false, trusted: true, version: helperVersion, fnMonitorAvailable: functionKeyMonitorAvailable, error: "Background hotkey dispatch failed.")
            }
            target.hotkeyDidDispatch(key)
            return Response(id: request.id, ok: true, trusted: true, version: helperVersion, fnMonitorAvailable: functionKeyMonitorAvailable, error: nil)
        }
        guard request.targetMode == nil || request.targetMode == "configured" else {
            return Response(id: request.id, ok: false, trusted: true, version: helperVersion, fnMonitorAvailable: functionKeyMonitorAvailable, error: "Unsupported target mode.")
        }
        if let error = validateForegroundTarget(request.targetBundleIds) {
            return Response(id: request.id, ok: false, trusted: true, version: helperVersion, fnMonitorAvailable: functionKeyMonitorAvailable, error: error)
        }
        guard postHotkey(key: key, modifiers: request.modifiers ?? []) else {
            return Response(id: request.id, ok: false, trusted: true, version: helperVersion, fnMonitorAvailable: functionKeyMonitorAvailable, error: "Hotkey dispatch failed.")
        }
        return Response(id: request.id, ok: true, trusted: true, version: helperVersion, fnMonitorAvailable: functionKeyMonitorAvailable, error: nil)
    case "releaseTarget":
        if let error = validateFreshness(request.timestampMs) {
            return Response(id: request.id, ok: false, trusted: trusted(prompt: false), version: helperVersion, fnMonitorAvailable: functionKeyMonitorAvailable, error: error)
        }
        if let contextId = request.targetContextId { refinementFieldLock.end(contextId: contextId) }
        targetRegistry.release(contextId: request.targetContextId)
        return Response(id: request.id, ok: true, trusted: trusted(prompt: false), version: helperVersion, fnMonitorAvailable: functionKeyMonitorAvailable, error: nil)
    default:
        return Response(id: request.id, ok: false, trusted: nil, version: helperVersion, fnMonitorAvailable: functionKeyMonitorAvailable, error: "Unknown helper request.")
    }
}

private final class FunctionKeyMonitor {
    private var eventTap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var pressed = false
    private var pressedTargetMode = "live"
    private let onStateChange: (Bool, String) -> Void

    init(onStateChange: @escaping (Bool, String) -> Void) {
        self.onStateChange = onStateChange
    }

    func start() -> Bool {
        guard eventTap == nil else { return true }
        let mask = CGEventMask(1) << CGEventType.flagsChanged.rawValue
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: mask,
            callback: FunctionKeyMonitor.callback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) else {
            return false
        }
        guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
            CFMachPortInvalidate(tap)
            return false
        }
        eventTap = tap
        runLoopSource = source
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        return true
    }

    func stop() {
        if pressed {
            pressed = false
            onStateChange(false, pressedTargetMode)
        }
        if let runLoopSource {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), runLoopSource, .commonModes)
        }
        if let eventTap {
            CGEvent.tapEnable(tap: eventTap, enable: false)
            CFMachPortInvalidate(eventTap)
        }
        runLoopSource = nil
        eventTap = nil
    }

    private func receive(type: CGEventType, event: CGEvent) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let eventTap { CGEvent.tapEnable(tap: eventTap, enable: true) }
            return
        }
        guard type == .flagsChanged else { return }
        let next = event.flags.contains(.maskSecondaryFn)
        guard next != pressed else { return }
        if next {
            pressedTargetMode = event.flags.contains(.maskControl) ? "pinned" : "live"
            pressed = true
            onStateChange(true, pressedTargetMode)
        } else {
            let targetMode = pressedTargetMode
            pressed = false
            onStateChange(false, targetMode)
        }
    }

    private static let callback: CGEventTapCallBack = { _, type, event, userInfo in
        if let userInfo {
            let monitor = Unmanaged<FunctionKeyMonitor>
                .fromOpaque(userInfo)
                .takeUnretainedValue()
            monitor.receive(type: type, event: event)
        }
        return Unmanaged.passUnretained(event)
    }

    deinit {
        stop()
    }
}

private final class LoopbackBridge {
    private let token: String
    private let connection: NWConnection
    private var receiveBuffer = Data()
    private var functionKeyMonitor: FunctionKeyMonitor?
    private var becameReady = false
    private var startupWatchdog: DispatchWorkItem?

    init?(portText: String, token: String) {
        guard let rawPort = UInt16(portText), let port = NWEndpoint.Port(rawValue: rawPort) else {
            return nil
        }
        self.token = token
        self.connection = NWConnection(host: "127.0.0.1", port: port, using: .tcp)
    }

    func start() {
        let watchdog = DispatchWorkItem { [weak self] in
            guard let self, !self.becameReady else { return }
            self.connection.cancel()
            exit(1)
        }
        startupWatchdog = watchdog
        DispatchQueue.main.asyncAfter(deadline: .now() + 8, execute: watchdog)

        connection.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                self.becameReady = true
                self.startupWatchdog?.cancel()
                self.startupWatchdog = nil
                self.sendHello()
                self.startFunctionKeyMonitor()
                self.receiveNext()
            case .failed, .cancelled:
                self.startupWatchdog?.cancel()
                refinementFieldLock.end(contextId: nil)
                exit(0)
            default:
                break
            }
        }
        connection.start(queue: .main)
    }

    private func sendHello() {
        guard var data = try? JSONSerialization.data(
            withJSONObject: ["type": "hello", "token": token]
        ) else {
            exit(1)
        }
        data.append(0x0A)
        connection.send(content: data, completion: .contentProcessed { error in
            if error != nil { exit(1) }
        })
    }

    private func startFunctionKeyMonitor() {
        refinementFieldLock.onCancel = { [weak self] contextId in
            guard let data = try? JSONSerialization.data(withJSONObject: [
                "type": "refinementCancelled", "targetContextId": contextId,
                "timestampMs": Date().timeIntervalSince1970 * 1_000,
            ]) else { return }
            var line = data
            line.append(0x0A)
            self?.connection.send(content: line, completion: .contentProcessed { _ in })
        }
        targetRegistry.onBindingChange = { [weak self] snapshot in
            self?.sendTargetBinding(snapshot)
        }
        let monitor = FunctionKeyMonitor { [weak self] pressed, targetMode in
            self?.sendFunctionKeyState(pressed: pressed, targetMode: targetMode)
        }
        functionKeyMonitorAvailable = monitor.start()
        functionKeyMonitor = monitor
    }

    private func sendFunctionKeyState(pressed: Bool, targetMode: String) {
        let event = FunctionKeyBridgeEvent(
            type: "functionKey",
            state: pressed ? "down" : "up",
            targetMode: targetMode,
            timestampMs: Date().timeIntervalSince1970 * 1_000
        )
        guard let data = encodedLine(event) else { return }
        connection.send(content: data, completion: .contentProcessed { error in
            if error != nil { exit(0) }
        })
    }

    private func sendTargetBinding(_ snapshot: TargetBindingSnapshot) {
        let event = TargetBindingBridgeEvent(
            type: "targetBinding",
            targetContextId: snapshot.targetContextId,
            binding: snapshot.binding,
            reason: snapshot.reason,
            timestampMs: Date().timeIntervalSince1970 * 1_000
        )
        guard let data = encodedLine(event) else { return }
        connection.send(content: data, completion: .contentProcessed { error in
            if error != nil { exit(0) }
        })
    }

    private func receiveNext() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, complete, error in
            guard let self else { return }
            if let data, !data.isEmpty {
                self.receiveBuffer.append(data)
                self.consumeLines()
            }
            if complete || error != nil {
                self.startupWatchdog?.cancel()
                refinementFieldLock.end(contextId: nil)
                self.functionKeyMonitor?.stop()
                targetRegistry.onBindingChange = nil
                self.connection.cancel()
                exit(0)
            }
            self.receiveNext()
        }
    }

    private func consumeLines() {
        while let newline = receiveBuffer.firstIndex(of: 0x0A) {
            let line = receiveBuffer.prefix(upTo: newline)
            receiveBuffer.removeSubrange(...newline)
            guard !line.isEmpty,
                  let request = try? JSONDecoder().decode(Request.self, from: Data(line)) else {
                continue
            }
            let response = autoreleasepool { handle(request) }
            guard let data = encodedLine(response) else { continue }
            connection.send(content: data, completion: .contentProcessed { error in
                if error != nil { exit(0) }
            })
        }
    }
}

private func argumentValue(after flag: String) -> String? {
    guard let index = CommandLine.arguments.firstIndex(of: flag),
          CommandLine.arguments.indices.contains(index + 1) else {
        return nil
    }
    return CommandLine.arguments[index + 1]
}

if let port = argumentValue(after: "--connect-port"),
   let token = argumentValue(after: "--token") {
    _ = NSApplication.shared
    NSApp.setActivationPolicy(.accessory)
    guard let bridge = LoopbackBridge(portText: port, token: token) else { exit(1) }
    bridge.start()
    NSApp.run()
} else {
    while let line = readLine() {
        autoreleasepool {
            guard let data = line.data(using: .utf8),
                  let request = try? JSONDecoder().decode(Request.self, from: data) else {
                return
            }
            sendToStdout(handle(request))
        }
    }
}
