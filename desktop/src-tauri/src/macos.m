#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>
#import <Security/Security.h>
#include <string.h>

// Compiled into the app. All blocking entrypoints below are called on Rust workers.
static void (*open_nerya)(void) = NULL;
@interface NeryaNotificationDelegate : NSObject <UNUserNotificationCenterDelegate>
@end
@implementation NeryaNotificationDelegate
- (void)userNotificationCenter:(UNUserNotificationCenter *)center
      willPresentNotification:(UNNotification *)notification
        withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completion {
    completion(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionList |
               UNNotificationPresentationOptionSound);
}
- (void)userNotificationCenter:(UNUserNotificationCenter *)center
 didReceiveNotificationResponse:(UNNotificationResponse *)response
        withCompletionHandler:(void (^)(void))completion {
    if (open_nerya) open_nerya();
    completion();
}
@end
static NeryaNotificationDelegate *delegate;
void nerya_notifications_init(void (*callback)(void)) {
    open_nerya = callback;
    delegate = [NeryaNotificationDelegate new];
    [UNUserNotificationCenter currentNotificationCenter].delegate = delegate;
}

// 0 = not requested, 1 = blocked, 2 = granted, 3 = granted quietly, -1 = timeout.
int nerya_notification_permission(void) {
    @autoreleasepool {
        dispatch_semaphore_t ready = dispatch_semaphore_create(0);
        __block int result = -1;
        [[UNUserNotificationCenter currentNotificationCenter] getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
            switch (settings.authorizationStatus) {
                case UNAuthorizationStatusNotDetermined: result = 0; break;
                case UNAuthorizationStatusDenied: result = 1; break;
                default: result = settings.alertSetting == UNNotificationSettingEnabled ? 2 : 3; break;
            }
            dispatch_semaphore_signal(ready);
        }];
        if (dispatch_semaphore_wait(ready, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC))) return -1;
        return result;
    }
}
int nerya_notification_authorize(void) {
    @autoreleasepool {
        int current = nerya_notification_permission();
        if (current != 0) return current;
        dispatch_semaphore_t ready = dispatch_semaphore_create(0);
        __block int result = -1;
        [[UNUserNotificationCenter currentNotificationCenter]
            requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound | UNAuthorizationOptionBadge)
            completionHandler:^(BOOL granted, NSError *error) {
                if (error) NSLog(@"Nerya notification authorization error %@:%ld", error.domain, (long)error.code);
                result = error ? -2 : (granted ? 2 : 1);
                dispatch_semaphore_signal(ready);
            }];
        if (dispatch_semaphore_wait(ready, dispatch_time(DISPATCH_TIME_NOW, 120 * NSEC_PER_SEC))) return -1;
        return result;
    }
}
int nerya_notification_send(const char *identifier, const char *body) {
    @autoreleasepool {
        UNMutableNotificationContent *content = [UNMutableNotificationContent new];
        content.title = @"Nerya";
        content.body = [NSString stringWithUTF8String:body];
        content.sound = UNNotificationSound.defaultSound;
        UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:[NSString stringWithUTF8String:identifier]
            content:content trigger:nil];
        dispatch_semaphore_t ready = dispatch_semaphore_create(0);
        __block int result = -1;
        [[UNUserNotificationCenter currentNotificationCenter] addNotificationRequest:request withCompletionHandler:^(NSError *error) {
            if (error) NSLog(@"Nerya notification delivery error %@:%ld", error.domain, (long)error.code);
            result = error ? -2 : 0;
            dispatch_semaphore_signal(ready);
        }];
        if (dispatch_semaphore_wait(ready, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC))) return -1;
        return result;
    }
}
int nerya_notification_delivered(const char *identifier) {
    @autoreleasepool {
        NSString *wanted = [NSString stringWithUTF8String:identifier];
        dispatch_semaphore_t ready = dispatch_semaphore_create(0);
        __block int result = 0;
        [[UNUserNotificationCenter currentNotificationCenter] getDeliveredNotificationsWithCompletionHandler:^(NSArray<UNNotification *> *items) {
            for (UNNotification *item in items) {
                if ([item.request.identifier isEqualToString:wanted]) { result = 1; break; }
            }
            dispatch_semaphore_signal(ready);
        }];
        if (dispatch_semaphore_wait(ready, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC))) return -1;
        return result;
    }
}

// A unique installation key is generated once and kept in the OS Keychain.
// Model credentials remain encrypted by the existing SecretVault, never logged.
int nerya_vault_key(char *output, size_t capacity) {
    @autoreleasepool {
        NSDictionary *identity = @{(__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
            (__bridge id)kSecAttrService: @"app.nerya.desktop", (__bridge id)kSecAttrAccount: @"vault-v1"};
        NSMutableDictionary *query = [identity mutableCopy];
        query[(__bridge id)kSecReturnData] = @YES;
        query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
        CFTypeRef raw = NULL;
        OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &raw);
        NSData *data = CFBridgingRelease(raw);
        if (status == errSecItemNotFound) {
            unsigned char bytes[48];
            if (SecRandomCopyBytes(kSecRandomDefault, sizeof(bytes), bytes) != errSecSuccess) return -1;
            NSString *encoded = [[NSData dataWithBytes:bytes length:sizeof(bytes)] base64EncodedStringWithOptions:0];
            memset(bytes, 0, sizeof(bytes));
            data = [encoded dataUsingEncoding:NSUTF8StringEncoding];
            NSMutableDictionary *entry = [identity mutableCopy];
            entry[(__bridge id)kSecValueData] = data;
            entry[(__bridge id)kSecAttrAccessible] = (__bridge id)kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly;
            status = SecItemAdd((__bridge CFDictionaryRef)entry, NULL);
            if (status == errSecDuplicateItem) return nerya_vault_key(output, capacity);
        }
        if (status != errSecSuccess || data.length < 32 || data.length >= capacity) return -1;
        memcpy(output, data.bytes, data.length);
        output[data.length] = 0;
        return 0;
    }
}
