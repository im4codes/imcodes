// Compiled only by scripts/build-aidesk-app.mjs (native/macos-remote-desktop/aidesk-agent-build.json), always with -fobjc-arc: the
// remote-desktop worker build (build-worker-from-sdk.sh) excludes it.
#if !__has_feature(objc_arc)
#error "aidesk_panel_window.mm requires Objective-C ARC"
#endif

#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>

#include "aidesk_panel_window.h"
#include "aidesk_ui_support.h"

#include "../remote-desktop-common/aidesk_product_name.h"
#include "../remote-desktop-common/platform_interfaces.h"

namespace common = imcodes::remote_desktop::common;
namespace macos = imcodes::remote_desktop::macos;

namespace {

NSURL *PanelUrl() {
  return [NSURL URLWithString:@(common::kLocalManagementUrl)];
}

// The panel's own origin, exactly: scheme, host and port, no credentials.
BOOL IsPanelOrigin(NSURL *url) {
  NSURL *panel = PanelUrl();
  if (url == nil || panel == nil) return NO;
  if (url.user != nil || url.password != nil) return NO;
  return [url.scheme.lowercaseString isEqualToString:panel.scheme] &&
         [url.host.lowercaseString isEqualToString:panel.host] &&
         url.port.integerValue == panel.port.integerValue;
}

// Menu words in the languages the panel itself speaks; English otherwise.
NSString *MenuWord(NSString *key) {
  static NSDictionary<NSString *, NSDictionary<NSString *, NSString *> *> *table;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    table = @{
      @"hide": @{@"en": @"Hide", @"zh-Hans": @"隐藏", @"zh-Hant": @"隱藏", @"es": @"Ocultar", @"ru": @"Скрыть", @"ja": @"隠す", @"ko": @"가리기"},
      @"quit": @{@"en": @"Quit", @"zh-Hans": @"退出", @"zh-Hant": @"結束", @"es": @"Salir de", @"ru": @"Завершить", @"ja": @"終了", @"ko": @"종료"},
      @"edit": @{@"en": @"Edit", @"zh-Hans": @"编辑", @"zh-Hant": @"編輯", @"es": @"Edición", @"ru": @"Правка", @"ja": @"編集", @"ko": @"편집"},
      @"cut": @{@"en": @"Cut", @"zh-Hans": @"剪切", @"zh-Hant": @"剪下", @"es": @"Cortar", @"ru": @"Вырезать", @"ja": @"カット", @"ko": @"오려두기"},
      @"copy": @{@"en": @"Copy", @"zh-Hans": @"拷贝", @"zh-Hant": @"拷貝", @"es": @"Copiar", @"ru": @"Копировать", @"ja": @"コピー", @"ko": @"복사"},
      @"paste": @{@"en": @"Paste", @"zh-Hans": @"粘贴", @"zh-Hant": @"貼上", @"es": @"Pegar", @"ru": @"Вставить", @"ja": @"ペースト", @"ko": @"붙여넣기"},
      @"selectAll": @{@"en": @"Select All", @"zh-Hans": @"全选", @"zh-Hant": @"全選", @"es": @"Seleccionar todo", @"ru": @"Выбрать все", @"ja": @"すべてを選択", @"ko": @"모두 선택"},
      @"window": @{@"en": @"Window", @"zh-Hans": @"窗口", @"zh-Hant": @"視窗", @"es": @"Ventana", @"ru": @"Окно", @"ja": @"ウインドウ", @"ko": @"윈도우"},
      @"minimize": @{@"en": @"Minimize", @"zh-Hans": @"最小化", @"zh-Hant": @"最小化", @"es": @"Minimizar", @"ru": @"Свернуть", @"ja": @"しまう", @"ko": @"최소화"},
      @"starting": @{@"en": @"Starting aiDesk…", @"zh-Hans": @"正在启动 aiDesk…", @"zh-Hant": @"正在啟動 aiDesk…", @"es": @"Iniciando aiDesk…", @"ru": @"Запуск aiDesk…", @"ja": @"aiDesk を起動しています…", @"ko": @"aiDesk를 시작하는 중…"},
      @"waiting": @{@"en": @"aiDesk is not answering yet. Trying again…", @"zh-Hans": @"aiDesk 暂时没有响应，正在重试…", @"zh-Hant": @"aiDesk 暫時沒有回應，正在重試…", @"es": @"aiDesk aún no responde. Reintentando…", @"ru": @"aiDesk пока не отвечает. Повторная попытка…", @"ja": @"aiDesk がまだ応答しません。再試行しています…", @"ko": @"aiDesk가 아직 응답하지 않습니다. 다시 시도하는 중…"},
      @"close": @{@"en": @"Close", @"zh-Hans": @"关闭", @"zh-Hant": @"關閉", @"es": @"Cerrar", @"ru": @"Закрыть", @"ja": @"閉じる", @"ko": @"닫기"},
    };
  });
  NSString *language = NSLocale.preferredLanguages.firstObject.lowercaseString ?: @"en";
  NSString *code = [language hasPrefix:@"zh-hant"] || [language hasPrefix:@"zh-tw"] || [language hasPrefix:@"zh-hk"] ? @"zh-Hant"
      : [language hasPrefix:@"zh"] ? @"zh-Hans"
      : [language hasPrefix:@"es"] ? @"es"
      : [language hasPrefix:@"ru"] ? @"ru"
      : [language hasPrefix:@"ja"] ? @"ja"
      : [language hasPrefix:@"ko"] ? @"ko" : @"en";
  return table[key][code] ?: table[key][@"en"];
}

NSMenuItem *Item(NSString *title, SEL action, NSString *key) {
  return [[NSMenuItem alloc] initWithTitle:title action:action keyEquivalent:key];
}

// Without a main menu there are no key equivalents: Cmd-C, Cmd-V, Cmd-W and Cmd-Q would do nothing in the web view.
void InstallMainMenuOnce() {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    NSString *name = @(common::kAiDeskProductName);
    NSMenu *main = [[NSMenu alloc] init];

    NSMenuItem *appItem = [[NSMenuItem alloc] init];
    NSMenu *appMenu = [[NSMenu alloc] initWithTitle:name];
    [appMenu addItem:Item([NSString stringWithFormat:@"%@ %@", MenuWord(@"hide"), name], @selector(hide:), @"h")];
    [appMenu addItem:[NSMenuItem separatorItem]];
    [appMenu addItem:Item([NSString stringWithFormat:@"%@ %@", MenuWord(@"quit"), name], @selector(terminate:), @"q")];
    appItem.submenu = appMenu;
    [main addItem:appItem];

    NSMenuItem *editItem = [[NSMenuItem alloc] init];
    NSMenu *editMenu = [[NSMenu alloc] initWithTitle:MenuWord(@"edit")];
    [editMenu addItem:Item(MenuWord(@"cut"), @selector(cut:), @"x")];
    [editMenu addItem:Item(MenuWord(@"copy"), @selector(copy:), @"c")];
    [editMenu addItem:Item(MenuWord(@"paste"), @selector(paste:), @"v")];
    [editMenu addItem:Item(MenuWord(@"selectAll"), @selector(selectAll:), @"a")];
    editItem.submenu = editMenu;
    [main addItem:editItem];

    NSMenuItem *windowItem = [[NSMenuItem alloc] init];
    NSMenu *windowMenu = [[NSMenu alloc] initWithTitle:MenuWord(@"window")];
    [windowMenu addItem:Item(MenuWord(@"minimize"), @selector(performMiniaturize:), @"m")];
    [windowMenu addItem:Item(MenuWord(@"close"), @selector(performClose:), @"w")];
    windowItem.submenu = windowMenu;
    [main addItem:windowItem];

    NSApp.mainMenu = main;
    NSApp.windowsMenu = windowMenu;
  });
}

}  // namespace

@interface AiDeskPanelWindowController : NSObject <NSWindowDelegate, WKNavigationDelegate, WKUIDelegate>
@property(nonatomic, strong) NSWindow *window;
@property(nonatomic, strong) WKWebView *webView;
@property(nonatomic) BOOL lastLoadFailed;
@property(nonatomic, strong) NSTimer *retryTimer;
@property(nonatomic, strong) NSVisualEffectView *skeleton;
@property(nonatomic, strong) NSTextField *skeletonLabel;
@property(nonatomic) NSUInteger failureCount;
- (void)show;
@end

@implementation AiDeskPanelWindowController

- (void)show {
  InstallMainMenuOnce();
  if (self.window == nil) [self createWindow];
  if (self.window.isMiniaturized) [self.window deminiaturize:nil];
  if (self.lastLoadFailed && self.webView != nil) [self load];
  [self.window makeKeyAndOrderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];
  macos::UiLogEvent("panel_window_shown");
}

// The window and a themed placeholder only; the web view (a WebKit process start, hundreds of ms to seconds on a loaded Mac) is
// attached on the next turn of the run loop, after the window has been painted, so a click is answered at once.
- (void)createWindow {
  macos::UiPhase(macos::kUiPhasePanelWindow);
  NSRect frame = NSMakeRect(0, 0, common::kLocalPanelWindowWidth, common::kLocalPanelWindowHeight);
  NSWindow *window = [[NSWindow alloc]
      initWithContentRect:frame
                styleMask:(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                           NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable)
                  backing:NSBackingStoreBuffered
                    defer:NO];
  window.title = @(common::kAiDeskProductName);
  window.releasedWhenClosed = NO;
  window.contentMinSize = NSMakeSize(common::kLocalPanelWindowMinWidth, common::kLocalPanelWindowMinHeight);
  window.delegate = self;
  [window center];
  // The user's own size and place win over the default once they have set them.
  [window setFrameAutosaveName:@"AiDeskPanelWindow"];

  NSView *content = (NSView *)window.contentView;
  NSVisualEffectView *skeleton = [[NSVisualEffectView alloc] initWithFrame:content.bounds];
  skeleton.material = NSVisualEffectMaterialWindowBackground;
  skeleton.blendingMode = NSVisualEffectBlendingModeBehindWindow;
  skeleton.state = NSVisualEffectStateActive;
  skeleton.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  NSTextField *label = [NSTextField labelWithString:MenuWord(@"starting")];
  label.font = [NSFont systemFontOfSize:15];
  label.textColor = NSColor.secondaryLabelColor;
  label.alignment = NSTextAlignmentCenter;
  label.autoresizingMask = NSViewWidthSizable | NSViewMinYMargin | NSViewMaxYMargin;
  label.frame = NSMakeRect(0, (content.bounds.size.height - 24) / 2, content.bounds.size.width, 24);
  [skeleton addSubview:label];
  [content addSubview:skeleton];

  self.window = window;
  self.skeleton = skeleton;
  self.skeletonLabel = label;
  macos::UiPhase(macos::kUiPhaseIdle);
  [self performSelector:@selector(attachWebView) withObject:nil afterDelay:0.05];
}

- (void)attachWebView {
  if (self.window == nil || self.webView != nil) return;
  macos::UiPhase(macos::kUiPhasePanelWebView);
  // Nothing of the panel (cookies, cache) is written to disk: each open is a fresh session, like the browser tab it replaces.
  WKWebViewConfiguration *configuration = [[WKWebViewConfiguration alloc] init];
  configuration.websiteDataStore = [WKWebsiteDataStore nonPersistentDataStore];
  NSView *content = (NSView *)self.window.contentView;
  WKWebView *webView = [[WKWebView alloc] initWithFrame:content.bounds configuration:configuration];
  webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  webView.navigationDelegate = self;
  webView.UIDelegate = self;
  webView.allowsBackForwardNavigationGestures = NO;
  webView.hidden = YES;  // the placeholder shows until the page has loaded
  [content addSubview:webView positioned:NSWindowBelow relativeTo:self.skeleton];
  self.webView = webView;
  macos::UiPhase(macos::kUiPhaseIdle);
  macos::UiLogEvent("panel_web_view_attached");
  [self load];
}

- (void)load {
  self.lastLoadFailed = NO;
  [self.retryTimer invalidate];
  self.retryTimer = nil;
  macos::UiLogEvent("panel_load_start");
  [self.webView loadRequest:[NSURLRequest requestWithURL:PanelUrl()
                                             cachePolicy:NSURLRequestReloadIgnoringLocalCacheData
                                         timeoutInterval:10]];
}

// The panel is not answering (the node is restarting or not running): say so in the window and try again with a growing pause
// (2, 4, 8, then 15 seconds) while the window is open.
- (void)loadFailed {
  self.lastLoadFailed = YES;
  self.webView.hidden = YES;
  self.skeleton.hidden = NO;
  self.skeletonLabel.stringValue = MenuWord(@"waiting");
  macos::UiLogEvent("panel_load_failed");
  if (self.retryTimer != nil || self.window == nil) return;
  const NSTimeInterval pause = MIN(15.0, 2.0 * (double)(1u << MIN(self.failureCount, 3u)));
  self.failureCount += 1;
  __weak AiDeskPanelWindowController *weakSelf = self;
  self.retryTimer = [NSTimer scheduledTimerWithTimeInterval:pause repeats:NO block:^(NSTimer *timer) {
    (void)timer;
    AiDeskPanelWindowController *strongSelf = weakSelf;
    strongSelf.retryTimer = nil;
    if (strongSelf.window != nil && strongSelf.lastLoadFailed) [strongSelf load];
  }];
}

#pragma mark - WKNavigationDelegate

// The window shows the panel's origin and nothing else, whatever the page does.
- (void)webView:(WKWebView *)webView
    decidePolicyForNavigationAction:(WKNavigationAction *)navigationAction
                    decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
  (void)webView;
  decisionHandler(IsPanelOrigin(navigationAction.request.URL) ? WKNavigationActionPolicyAllow
                                                              : WKNavigationActionPolicyCancel);
}

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
  (void)navigation;
  self.failureCount = 0;
  self.skeleton.hidden = YES;
  webView.hidden = NO;
  macos::UiLogEvent("panel_loaded");
}

- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
  (void)webView; (void)navigation;
  if (error.code == NSURLErrorCancelled) return;
  [self loadFailed];
}

- (void)webView:(WKWebView *)webView didFailNavigation:(WKNavigation *)navigation withError:(NSError *)error {
  (void)webView; (void)navigation;
  if (error.code == NSURLErrorCancelled) return;
  [self loadFailed];
}

- (void)webViewWebContentProcessDidTerminate:(WKWebView *)webView {
  (void)webView;
  [self loadFailed];
}

#pragma mark - WKUIDelegate

// `window.open` and target=_blank never create a window.
- (WKWebView *)webView:(WKWebView *)webView
    createWebViewWithConfiguration:(WKWebViewConfiguration *)configuration
               forNavigationAction:(WKNavigationAction *)navigationAction
                    windowFeatures:(WKWindowFeatures *)windowFeatures {
  (void)webView; (void)configuration; (void)navigationAction; (void)windowFeatures;
  return nil;
}

#pragma mark - NSWindowDelegate

// Closing the window closes only the window: the application (and the node) keep running. The web content process goes with it.
- (void)windowWillClose:(NSNotification *)notification {
  (void)notification;
  [self.retryTimer invalidate];
  self.retryTimer = nil;
  [NSObject cancelPreviousPerformRequestsWithTarget:self selector:@selector(attachWebView) object:nil];
  self.skeleton = nil;
  self.skeletonLabel = nil;
  self.failureCount = 0;
  WKWebView *webView = self.webView;
  NSWindow *window = self.window;
  self.webView = nil;
  self.window = nil;
  webView.navigationDelegate = nil;
  webView.UIDelegate = nil;
  window.delegate = nil;
  dispatch_async(dispatch_get_main_queue(), ^{
    [webView removeFromSuperview];
    (void)window;
  });
}

@end

namespace imcodes::remote_desktop::macos {

void ShowLocalPanelWindow() {
  static AiDeskPanelWindowController *controller;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ controller = [[AiDeskPanelWindowController alloc] init]; });
  [controller show];
}

}  // namespace imcodes::remote_desktop::macos
