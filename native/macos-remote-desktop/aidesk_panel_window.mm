#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>

#include "aidesk_panel_window.h"

#include "../remote-desktop-common/aidesk_product_name.h"
#include "../remote-desktop-common/platform_interfaces.h"

namespace common = imcodes::remote_desktop::common;

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
- (void)show;
@end

@implementation AiDeskPanelWindowController

- (void)show {
  InstallMainMenuOnce();
  if (self.window == nil) [self createWindow];
  if (self.window.isMiniaturized) [self.window deminiaturize:nil];
  if (self.lastLoadFailed) [self load];
  [self.window makeKeyAndOrderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];
}

- (void)createWindow {
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

  // Nothing of the panel (cookies, cache) is written to disk: each open is a fresh session, like the browser tab it replaces.
  WKWebViewConfiguration *configuration = [[WKWebViewConfiguration alloc] init];
  configuration.websiteDataStore = [WKWebsiteDataStore nonPersistentDataStore];
  WKWebView *webView = [[WKWebView alloc] initWithFrame:((NSView *)window.contentView).bounds
                                          configuration:configuration];
  webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  webView.navigationDelegate = self;
  webView.UIDelegate = self;
  webView.allowsBackForwardNavigationGestures = NO;
  [window.contentView addSubview:webView];

  self.window = window;
  self.webView = webView;
  [self load];
}

- (void)load {
  self.lastLoadFailed = NO;
  [self.retryTimer invalidate];
  self.retryTimer = nil;
  [self.webView loadRequest:[NSURLRequest requestWithURL:PanelUrl()
                                             cachePolicy:NSURLRequestReloadIgnoringLocalCacheData
                                         timeoutInterval:10]];
}

// The panel is not answering (the node is restarting): try again every couple of seconds while the window is open.
- (void)loadFailed {
  self.lastLoadFailed = YES;
  if (self.retryTimer != nil || self.window == nil) return;
  __weak AiDeskPanelWindowController *weakSelf = self;
  self.retryTimer = [NSTimer scheduledTimerWithTimeInterval:2.0 repeats:NO block:^(NSTimer *timer) {
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
