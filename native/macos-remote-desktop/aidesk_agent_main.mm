// The main executable of the signed aiDesk.to application bundle.
//
// Its whole job is to be the process macOS attributes permissions to. Screen
// Recording and Accessibility are granted to a *responsible application*, and
// helpers launched from a root daemon are otherwise attributed to whatever
// started them -- a terminal, launchd, sudo -- so the grant lands on something
// the user never chose and cannot see. Shipping every helper inside one signed
// bundle whose main executable replaces itself with the helper makes that
// responsible application this app, once, for all of them.
//
// Two ways in, and they are the only two:
//
//   Finder or Dock double-click  -> ask for the permissions.
//   Anything else                -> become the helper the arguments name.
//
// Deliberately free of the remote-desktop stack. The onboarding unit needs
// only AppKit and ApplicationServices, so this builds with clang alone on any
// macOS machine; linking the worker's libwebrtc world in here would make the
// app unbuildable without it, for no gain.

#import <AppKit/AppKit.h>

#include <sysexits.h>

#include <cstdlib>
#include <cstring>
#include <iostream>

#include "aidesk_fs_delegate.h"
#include "macos_permission_onboarding.h"
#include "../remote-desktop-common/platform_interfaces.h"
#include "../remote-desktop-common/aidesk_product_name.h"
#include "aidesk_panel_window.h"
#include "aidesk_ui_support.h"
#include "../remote-desktop-common/local_indicator_visuals.h"

namespace macos = imcodes::remote_desktop::macos;

namespace {
// Set by `--aidesk-open-panel`: the node started this application to show the panel, and nothing is running yet to be asked.
bool g_open_panel_on_launch = false;

// The panel is this application's own window (a web view): the Dock, Cmd-Tab and the menu bar show aiDesk.to's icon and name, and a
// second request activates the window that exists. Nothing goes through the node, so an older node works as well as a new one.
bool OpenLocalManagementPanel() {
  dispatch_async(dispatch_get_main_queue(), ^{ macos::ShowLocalPanelWindow(); });
  return true;
}

bool IsLoopbackStatusUrl(NSURL *url) {
  if (url == nil || ![url.scheme isEqualToString:@"http"]) return false;
  NSString *host = url.host.lowercaseString;
  return [host isEqualToString:@"127.0.0.1"] ||
         [host isEqualToString:@"localhost"] ||
         [host isEqualToString:@"::1"];
}

NSDictionary *StatusPresentation(NSDictionary *state, NSInteger http_status) {
  const BOOL paused = [state[@"paused"] boolValue];
  NSArray *connections = state[@"connections"];
  const NSUInteger viewers =
      [connections isKindOfClass:[NSArray class]] ? connections.count : 0;
  NSUInteger controllers = 0;
  for (NSDictionary *connection in connections) {
    if ([connection[@"mode"] isEqualToString:@"control"]) ++controllers;
  }
  const std::string badge =
      imcodes::remote_desktop::common::LocalIndicatorBadgeText(viewers);
  return @{
    @"httpStatus" : @(http_status),
    @"paused" : @(paused),
    @"viewers" : @(viewers),
    @"controllers" : @(controllers),
    @"glyph" : paused ? @"Ⅱ" : viewers > 0 ? @"●" : @"ai",
    @"color" : paused ? @"paused" : controllers > 0 ? @"control"
        : viewers > 0 ? @"view" : @"idle",
    @"badge" : [NSString stringWithUTF8String:badge.c_str()],
  };
}
}

@interface AiDeskLocalStateClient : NSObject
@property(nonatomic, strong) NSURLSession *session;
@property(nonatomic, strong) NSURL *rootURL;
@property(nonatomic, strong) NSURL *stateURL;
@property(nonatomic) BOOL bootstrapped;
- (instancetype)initWithStateURL:(NSURL *)stateURL;
- (void)fetch:(void (^)(NSDictionary *, NSInteger, NSError *))completion;
@end

@implementation AiDeskLocalStateClient
- (instancetype)initWithStateURL:(NSURL *)stateURL {
  self = [super init];
  if (self == nil || !IsLoopbackStatusUrl(stateURL)) return nil;
  NSURLComponents *root = [NSURLComponents componentsWithURL:stateURL
                                     resolvingAgainstBaseURL:NO];
  root.path = @"/";
  root.query = nil;
  root.fragment = nil;
  NSURLSessionConfiguration *configuration =
      [NSURLSessionConfiguration ephemeralSessionConfiguration];
  // A node that accepts the connection and does not answer must not hold the status poll for the 60 s default.
  configuration.timeoutIntervalForRequest = 4;
  configuration.HTTPShouldSetCookies = YES;
  configuration.HTTPCookieAcceptPolicy = NSHTTPCookieAcceptPolicyAlways;
  self.session = [NSURLSession sessionWithConfiguration:configuration];
  self.rootURL = root.URL;
  self.stateURL = stateURL;
  return self;
}

- (void)fetchState:(void (^)(NSDictionary *, NSInteger, NSError *))completion
              retry:(BOOL)retry {
  [[[self session] dataTaskWithURL:self.stateURL
      completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        const NSInteger status =
            [response isKindOfClass:[NSHTTPURLResponse class]]
                ? ((NSHTTPURLResponse *)response).statusCode
                : 0;
        if (status == 401 && retry) {
          self.bootstrapped = NO;
          [[[self session] dataTaskWithURL:self.rootURL
              completionHandler:^(NSData *root_data, NSURLResponse *root_response,
                                  NSError *root_error) {
                (void)root_data;
                const NSInteger root_status =
                    [root_response isKindOfClass:[NSHTTPURLResponse class]]
                        ? ((NSHTTPURLResponse *)root_response).statusCode
                        : 0;
                if (root_error != nil || root_status != 200) {
                  completion(nil, root_status, root_error);
                  return;
                }
                self.bootstrapped = YES;
                [self fetchState:completion retry:NO];
              }] resume];
          return;
        }
        NSDictionary *state = nil;
        if (error == nil && status == 200 && data != nil) {
          NSError *decode_error = nil;
          id decoded = [NSJSONSerialization JSONObjectWithData:data
                                                       options:0
                                                         error:&decode_error];
          if (decode_error != nil) error = decode_error;
          if ([decoded isKindOfClass:[NSDictionary class]]) state = decoded;
        }
        completion(state, status, error);
      }] resume];
}

- (void)fetch:(void (^)(NSDictionary *, NSInteger, NSError *))completion {
  if (self.bootstrapped) {
    [self fetchState:completion retry:YES];
    return;
  }
  [[[self session] dataTaskWithURL:self.rootURL
      completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        (void)data;
        const NSInteger status =
            [response isKindOfClass:[NSHTTPURLResponse class]]
                ? ((NSHTTPURLResponse *)response).statusCode
                : 0;
        if (error != nil || status != 200) {
          completion(nil, status, error);
          return;
        }
        self.bootstrapped = YES;
        [self fetchState:completion retry:NO];
      }] resume];
}
@end

@interface AiDeskApplicationDelegate : NSObject <NSApplicationDelegate>
@property(nonatomic, strong) NSStatusItem *statusItem;
@property(nonatomic, strong) NSTimer *statusTimer;
@property(nonatomic, strong) AiDeskLocalStateClient *statusClient;
@property(nonatomic) BOOL statusFetchInFlight;
@end

@implementation AiDeskApplicationDelegate
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  (void)notification;
  macos::UiPhase(macos::kUiPhaseStatusItem);
  self.statusItem = [[NSStatusBar systemStatusBar]
      statusItemWithLength:NSVariableStatusItemLength];
  self.statusItem.button.title = @"ai";
  self.statusItem.button.toolTip = [NSString stringWithUTF8String:
      imcodes::remote_desktop::common::kAiDeskProductName];
  self.statusItem.button.target = self;
  self.statusItem.button.action = @selector(openPanel:);
  self.statusClient = [[AiDeskLocalStateClient alloc]
      initWithStateURL:[NSURL URLWithString:@(
          imcodes::remote_desktop::common::kLocalManagementStateUrl)]];
  [self refreshStatus:nil];
  // Another request for the panel (a second launch of the app, or the node) is handed to this instance: it opens the window.
  macos::ObserveUiRequests(^{ OpenLocalManagementPanel(); });
  if (g_open_panel_on_launch) OpenLocalManagementPanel();
  self.statusTimer = [NSTimer scheduledTimerWithTimeInterval:2.0
      target:self selector:@selector(refreshStatus:) userInfo:nil repeats:YES];
}

- (void)openPanel:(id)sender {
  (void)sender;
  OpenLocalManagementPanel();
}

- (void)refreshStatus:(NSTimer *)timer {
  (void)timer;
  if (self.statusFetchInFlight || self.statusClient == nil) return;
  self.statusFetchInFlight = YES;
  [self.statusClient fetch:^(NSDictionary *state, NSInteger status,
                             NSError *error) {
        (void)status;
        dispatch_async(dispatch_get_main_queue(), ^{
          self.statusFetchInFlight = NO;
          if (error != nil || state == nil) {
            self.statusItem.button.attributedTitle = [[NSAttributedString alloc]
                initWithString:@"■" attributes:@{
                  NSForegroundColorAttributeName: [NSColor secondaryLabelColor]
                }];
            [NSApp dockTile].badgeLabel = nil;
            return;
          }
          NSDictionary *presentation = StatusPresentation(state, 200);
          NSString *colorKey = presentation[@"color"];
          NSColor *color = [colorKey isEqualToString:@"paused"]
              ? [NSColor secondaryLabelColor]
              : [colorKey isEqualToString:@"control"] ? [NSColor systemRedColor]
              : [colorKey isEqualToString:@"view"] ? [NSColor systemOrangeColor]
              : [NSColor systemBlueColor];
          NSString *glyph = presentation[@"glyph"];
          NSString *badge = presentation[@"badge"];
          NSString *title = badge.length > 0
              ? [NSString stringWithFormat:@"%@ %@", glyph, badge]
              : glyph;
          self.statusItem.button.attributedTitle = [[NSAttributedString alloc]
              initWithString:title attributes:@{NSForegroundColorAttributeName: color}];
          [NSApp dockTile].badgeLabel = badge.length > 0 ? badge : nil;
        });
      }];
}

- (BOOL)applicationShouldHandleReopen:(NSApplication *)application
                    hasVisibleWindows:(BOOL)hasVisibleWindows {
  (void)application;
  (void)hasVisibleWindows;
  OpenLocalManagementPanel();
  return YES;
}
@end

int main(int argc, char* argv[]) {
  // The node asks this app to do the one filesystem call its own bare executable is denied (Full Disk Access is granted to this app,
  // the identity the user sees). Answers one request file and exits; see aidesk_fs_delegate.h. Before anything that registers an
  // application identity or opens UI: it is a headless one-shot.
  if (imcodes::aidesk::fs_delegate::IsFsDelegateInvocation(argc, argv)) {
    return imcodes::aidesk::fs_delegate::FsDelegateMain(argc, argv);
  }
  // `--aidesk-ui-log`: the diagnostics log (what the app did and when the main thread was late), headless.
  if (argc == 2 && std::strcmp(argv[1], macos::kAiDeskUiLogArgument) == 0) return macos::PrintUiLog();
  if (argc == 3 && std::strcmp(argv[1], "--aidesk-status-probe") == 0) {
    @autoreleasepool {
      NSURL *state_url = [NSURL URLWithString:[NSString stringWithUTF8String:argv[2]]];
      AiDeskLocalStateClient *client =
          [[AiDeskLocalStateClient alloc] initWithStateURL:state_url];
      if (client == nil) return EX_USAGE;
      dispatch_semaphore_t done = dispatch_semaphore_create(0);
      __block NSDictionary *result = nil;
      [client fetch:^(NSDictionary *state, NSInteger status, NSError *error) {
        if (error == nil && state != nil) result = StatusPresentation(state, status);
        dispatch_semaphore_signal(done);
      }];
      // blocking-ok: `--aidesk-status-probe` is a headless one-shot command (no window, no run loop), never the user-facing app
      if (dispatch_semaphore_wait(done,
              dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC)) != 0 ||
          result == nil) {
        std::cerr << "aidesk_status_probe_failed\n";
        return EX_UNAVAILABLE;
      }
      NSData *json = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
      std::cout << [[[NSString alloc] initWithData:json
                                           encoding:NSUTF8StringEncoding]
          UTF8String] << "\n";
      return EXIT_SUCCESS;
    }
  }
  const bool background_launch = (argc == 2 || argc == 3) &&
      std::strcmp(argv[1], "--aidesk-background") == 0 &&
      (argc == 2 || std::strcmp(argv[2], "--aidesk-open-panel") == 0);
  g_open_panel_on_launch = background_launch && argc == 3;
  const bool ui_role = background_launch || macos::IsLocalOnboardingAppLaunch(argc, argv);

  // Two roles share this bundle (one identity for the permission grants): the user-facing app (menu bar + panel window) and the
  // launcher that holds the remote-desktop helpers. LaunchServices treats them as one application, so a request for the app may reach
  // the launcher; the UI role therefore takes a lock of its own, and a second request is handed to the instance that has it.
  macos::UiDiagnosticsStart(ui_role ? "ui" : "launcher");
  macos::SetAppHooks(&macos::UiLogEvent, &macos::InstallLauncherReopenHandler);
  if (ui_role) {
    macos::UiPhase(macos::kUiPhaseClaimRole);
    if (macos::ClaimUiRole() == macos::UiRoleClaim::kHandedOver) {
      macos::UiLogFlush();
      return EXIT_SUCCESS;
    }
  }

  // Registers the LaunchServices identity without asking for anything, so a
  // later permission check is answered against this bundle rather than a
  // parent process.
  if (macos::IsMacosPermissionResponsibleApplication())
    macos::PrepareMacosPermissionResponsibleApplication();

  if (ui_role) {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    AiDeskApplicationDelegate *delegate = [[AiDeskApplicationDelegate alloc] init];
    [NSApp setDelegate:delegate];
    if (background_launch) {
      [NSApp run];
      return EXIT_SUCCESS;
    }
    // A Dock / Finder launch: the window first, at once. The permission prompts and the wait for the person's answer used to run
    // HERE, on the main thread, before the run loop started -- ten minutes of beach ball (and, if they were not granted, no window
    // ever) -- and now run on their own queue while the app already answers.
    OpenLocalManagementPanel();
    macos::StartPermissionRegistrationInBackground();
    [NSApp activateIgnoringOtherApps:YES];
    [NSApp run];
    return EXIT_SUCCESS;
  }

  if (!macos::IsAiDeskProductMainExecutable()) {
    // Running this outside the signed bundle would hand the caller an
    // exec into a path it chose. Refuse rather than resolve it.
    std::cerr << "aidesk_agent_requires_signed_bundle\n";
    return EX_USAGE;
  }

  (void)macos::ExecAiDeskProductHelper(
      macos::SelectAiDeskProductHelper(argc, argv), argc, argv);
  // `exec` only returns on failure.
  std::cerr << "aidesk_product_helper_exec_failed\n";
  return EX_UNAVAILABLE;
}
