import Foundation
import Security
import Capacitor

@objc(NativeSessionKeychainPlugin)
public final class NativeSessionKeychainPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeSessionKeychainPlugin"
    public let jsName = "NativeSessionKeychain"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise)
    ]

    private let service = "com.nebula.dashboard.account-session"

    private func account(_ call: CAPPluginCall) -> String? {
        guard let value = call.getString("account"), !value.isEmpty else {
            call.reject("A session account is required.")
            return nil
        }
        return value
    }

    private func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    @objc public func get(_ call: CAPPluginCall) {
        guard let account = account(call) else { return }
        var request = query(account)
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { call.resolve([:]); return }
        guard status == errSecSuccess, let data = result as? Data,
              let value = String(data: data, encoding: .utf8), !value.isEmpty else {
            _ = SecItemDelete(query(account) as CFDictionary)
            call.reject("Secure session storage is unavailable or corrupt.")
            return
        }
        call.resolve(["value": value])
    }

    @objc public func set(_ call: CAPPluginCall) {
        guard let account = account(call), let value = call.getString("value"), !value.isEmpty,
              let data = value.data(using: .utf8) else {
            call.reject("A non-empty session value is required.")
            return
        }
        let base = query(account)
        let updates: [String: Any] = [kSecValueData as String: data,
                                     kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let updateStatus = SecItemUpdate(base as CFDictionary, updates as CFDictionary)
        if updateStatus == errSecItemNotFound {
            var item = base
            updates.forEach { item[$0.key] = $0.value }
            let addStatus = SecItemAdd(item as CFDictionary, nil)
            guard addStatus == errSecSuccess else { call.reject("Secure session storage is unavailable."); return }
        } else if updateStatus != errSecSuccess {
            call.reject("Secure session storage is unavailable."); return
        }
        call.resolve()
    }

    @objc public func remove(_ call: CAPPluginCall) {
        guard let account = account(call) else { return }
        let status = SecItemDelete(query(account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            call.reject("Secure session cleanup failed."); return
        }
        call.resolve()
    }
}
