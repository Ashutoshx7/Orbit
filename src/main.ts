/**
 * Astra Browser — Main Process Entry Point
 *
 * Orchestrates: AdBlocker, AppDatabase, TabManager, ShortcutManager,
 *               SpaceManager, CompactModeManager, GlanceManager
 */

import { app, BaseWindow, WebContentsView, ipcMain } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';

import { TabManager } from './managers/TabManager';
import { AdBlocker } from './managers/AdBlocker';
import { ShortcutManager } from './managers/ShortcutManager';
import { SpaceManager } from './managers/SpaceManager';
import { CompactModeManager } from './managers/CompactModeManager';
import { GlanceManager } from './managers/GlanceManager';
import { SplitViewManager } from './managers/SplitViewManager';
import { FingerprintGuard } from './managers/FingerprintGuard';
import { AppDatabase } from './database/Database';
import { IPC, CONFIG } from './types';
import { parseUrl } from './utils/url';

require('events').defaultMaxListeners = CONFIG.MAX_LISTENERS;

// --------------------------------------------------
// Chromium Performance Flags (inspired by Helium browser)
// --------------------------------------------------
app.commandLine.appendSwitch('enable-features',
  'ParallelDownloading,HighEfficiencyMode,UseOzonePlatform,VaapiVideoDecodeLinuxGL'
);
// Smoother scrolling & GPU acceleration
app.commandLine.appendSwitch('enable-smooth-scrolling');
app.commandLine.appendSwitch('enable-gpu-rasterization');
// Zero-copy texture upload (reduces GPU memory copies)
app.commandLine.appendSwitch('enable-zero-copy');
// Don't throttle background tabs — critical for tab restore & media
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
// Use hardware GPU even if blocklisted (Helium pattern)
app.commandLine.appendSwitch('ignore-gpu-blocklist');
// Faster compositing pipeline
app.commandLine.appendSwitch('enable-accelerated-video-decode');
app.commandLine.appendSwitch('enable-accelerated-2d-canvas');

if (started) app.quit();

let mainWindow: BaseWindow | null = null;
let tabManager: TabManager;
let spaceManager: SpaceManager;
let compactMode: CompactModeManager;
let glanceManager: GlanceManager;
let splitView: SplitViewManager;
let fingerprintGuard: FingerprintGuard;
let database: AppDatabase;

// --------------------------------------------------
// Window creation
// --------------------------------------------------

function createWindow(): void {
  mainWindow = new BaseWindow({
    width: CONFIG.WINDOW.WIDTH,
    height: CONFIG.WINDOW.HEIGHT,
    minWidth: CONFIG.WINDOW.MIN_WIDTH,
    minHeight: CONFIG.WINDOW.MIN_HEIGHT,
    title: CONFIG.WINDOW.TITLE,
    backgroundColor: CONFIG.WINDOW.BG_COLOR,
    titleBarStyle: 'hidden',
    // No titleBarOverlay — doesn't work on Linux.
    // Custom Zen-style controls: hidden behind content, revealed on hover.
  });

  // Ensure window background is dark — during resize compositor lag,
  // any gap between BrowserViews flashes the window background color.
  // Belt-and-suspenders: set on both BaseWindow AND each WebContentsView.
  mainWindow.setBackgroundColor(CONFIG.WINDOW.BG_COLOR);

  const sidebarView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  sidebarView.setBackgroundColor(CONFIG.WINDOW.BG_COLOR);
  mainWindow.contentView.addChildView(sidebarView);

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    sidebarView.webContents.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    sidebarView.webContents.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  // --------------------------------------------------
  // Managers
  // --------------------------------------------------

  const preloadPath = path.join(__dirname, 'preload.js');

  tabManager = new TabManager(mainWindow, sidebarView, database, preloadPath);
  spaceManager = new SpaceManager(database, sidebarView, tabManager);

  // CompactMode: controls sidebar auto-hide.
  // Hover keeps content full width; explicit toggle animates dock/undock layout.
  compactMode = new CompactModeManager(mainWindow, sidebarView, (sidebarWidth) => {
    tabManager.layoutWithSidebarWidth(sidebarWidth);
  }, (sidebarWidth, durationMs, easing) => {
    tabManager.animateContentForSidebarWidth(sidebarWidth, durationMs, easing);
  });

  // Glance: link preview overlay
  glanceManager = new GlanceManager(mainWindow, sidebarView, tabManager);

  // SplitView: side-by-side tabs
  splitView = new SplitViewManager(mainWindow, sidebarView, tabManager);

  // FingerprintGuard: privacy protection (Helium-inspired)
  fingerprintGuard = new FingerprintGuard();
  fingerprintGuard.initialize();

  const shortcutManager = new ShortcutManager(tabManager, sidebarView, database, () => mainWindow);

  // Bidirectional linking (Zen pattern: managers reference each other)
  tabManager.setSpaceManager(spaceManager);
  shortcutManager.setSpaceManager(spaceManager);
  shortcutManager.setCompactMode(compactMode);
  shortcutManager.setGlanceManager(glanceManager);
  shortcutManager.setSplitView(splitView);

  // Inject fingerprint protection into each new tab
  tabManager.setOnViewCreated((view) => {
    shortcutManager.attachToView(view);
    fingerprintGuard.injectProtections(view.webContents);
  });

  // Session restore — try to restore previous tabs, fallback to new tab
  const restored = tabManager.restoreSession();
  if (!restored) {
    const firstTab = tabManager.createTab();
    tabManager.switchToTab(firstTab.id);
  }

  shortcutManager.initialize();
  mainWindow.on('resize', () => tabManager.layout());

  // Save session before window closes
  mainWindow.on('close', () => {
    tabManager.saveSession();
  });

  // --------------------------------------------------
  // IPC Handlers
  // --------------------------------------------------

  ipcMain.on(IPC.REQUEST_TABS, () => tabManager.sendTabsToSidebar());
  ipcMain.on(IPC.NAVIGATE, (_e, url: string) => tabManager.navigateActiveTab(parseUrl(url)));
  ipcMain.on(IPC.GO_BACK, () => tabManager.goBack());
  ipcMain.on(IPC.GO_FORWARD, () => tabManager.goForward());
  ipcMain.on(IPC.REFRESH, () => tabManager.reload());

  ipcMain.on(IPC.NEW_TAB, (_e, url?: string) => {
    const tab = tabManager.createTab(url || undefined);
    tabManager.switchToTab(tab.id);
  });

  ipcMain.on(IPC.CLOSE_TAB, (_e, tabId: string) => tabManager.closeTab(tabId));
  ipcMain.on(IPC.SWITCH_TAB, (_e, tabId: string) => tabManager.switchToTab(tabId));

  ipcMain.on(IPC.REORDER_TABS, (_e, data: { oldIndex: number; newIndex: number }) => {
    tabManager.reorderTabs(data.oldIndex, data.newIndex);
  });

  // Hibernate
  ipcMain.on(IPC.HIBERNATE_TAB, (_e, tabId: string) => tabManager.hibernateTab(tabId));

  // Pin/Unpin
  ipcMain.on(IPC.PIN_TAB, (_e, tabId: string) => tabManager.pinTab(tabId));
  ipcMain.on(IPC.UNPIN_TAB, (_e, tabId: string) => tabManager.unpinTab(tabId));

  // Find in page
  ipcMain.on(IPC.FIND_IN_PAGE, (_e, text: string) => tabManager.findInPage(text));
  ipcMain.on(IPC.FIND_STOP, () => tabManager.stopFind());

  // History
  ipcMain.on(IPC.GET_HISTORY, () => {
    sidebarView.webContents.send(IPC.HISTORY_RESULT, database.getFullHistory());
  });

  ipcMain.on(IPC.CLEAR_HISTORY, () => {
    database.clearHistory();
    sidebarView.webContents.send(IPC.HISTORY_RESULT, []);
  });

  // Suggestions
  ipcMain.on(IPC.SEARCH_SUGGESTIONS, (_e, query: string) => {
    sidebarView.webContents.send(IPC.SUGGESTIONS_RESULT, database.getSuggestions(query));
  });

  // Bookmarks
  ipcMain.on(IPC.ADD_BOOKMARK, (_e, data: { url: string; title: string }) => {
    database.addBookmark(data.url, data.title);
    sidebarView.webContents.send(IPC.BOOKMARK_STATUS, true);
  });

  ipcMain.on(IPC.REMOVE_BOOKMARK, (_e, url: string) => {
    database.removeBookmark(url);
    sidebarView.webContents.send(IPC.BOOKMARK_STATUS, false);
  });

  ipcMain.on(IPC.GET_BOOKMARKS, () => {
    sidebarView.webContents.send(IPC.BOOKMARKS_RESULT, database.getBookmarks());
  });

  // DevTools in dev mode only
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    sidebarView.webContents.openDevTools({ mode: 'detach' });
  }

  // --------------------------------------------------
  // Workspace IPC Handlers (Zen-inspired)
  // --------------------------------------------------

  ipcMain.on(IPC.REQUEST_SPACES, () => spaceManager.sendSpacesToSidebar());

  ipcMain.on(IPC.SPACE_SWITCH, (_e, spaceId: string) => {
    spaceManager.switchToSpace(spaceId);
  });

  ipcMain.on(IPC.SPACE_CREATE, (_e, data: { name: string; color: string; icon: string }) => {
    spaceManager.createSpace(data.name, data.color, data.icon);
  });

  ipcMain.on(IPC.SPACE_DELETE, (_e, spaceId: string) => {
    spaceManager.deleteSpace(spaceId);
  });

  ipcMain.on(IPC.SPACE_RENAME, (_e, data: { spaceId: string; name: string }) => {
    spaceManager.renameSpace(data.spaceId, data.name);
  });

  ipcMain.on(IPC.SPACE_REORDER, (_e, data: { spaceId: string; newIndex: number }) => {
    spaceManager.reorderSpace(data.spaceId, data.newIndex);
  });

  ipcMain.on(IPC.SPACE_UPDATE_COLOR, (_e, data: { spaceId: string; color: string }) => {
    spaceManager.updateSpaceColor(data.spaceId, data.color);
  });

  // --------------------------------------------------
  // Compact Mode IPC Handlers
  // --------------------------------------------------

  ipcMain.on('compact:toggle', () => compactMode.toggleMode());
  ipcMain.on('compact:set-mode', (_e, mode: string) => {
    compactMode.setMode(mode as any);
  });
  ipcMain.on('compact:mouse-move', (_e, data: { x: number; y: number }) => {
    compactMode.handleMouseMove(data.x, data.y);
  });
  ipcMain.on('compact:lock-popup', () => compactMode.lockForPopup());
  ipcMain.on('compact:unlock-popup', () => compactMode.unlockFromPopup());

  // Edge hover detection (Wayland-compatible)
  ipcMain.on('compact:edge-enter', () => compactMode.onEdgeEnter());
  ipcMain.on('compact:edge-leave', (_e, data?: { x: number; y: number }) => compactMode.onEdgeLeave(data));
  ipcMain.on('compact:edge-cancel-hide', () => compactMode.onEdgeCancelHide());

  // --------------------------------------------------
  // Window Controls IPC (custom Zen-style buttons)
  // --------------------------------------------------
  ipcMain.on('window:minimize', () => mainWindow?.minimize());
  ipcMain.on('window:maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.on('window:close', () => mainWindow?.close());
  // Send maximize state back to renderer for button icon toggle
  mainWindow.on('maximize', () => sidebarView.webContents.send('window:maximized', true));
  mainWindow.on('unmaximize', () => sidebarView.webContents.send('window:maximized', false));
  // --------------------------------------------------
  // Zen-style toolbar reveal — IPC-driven
  //
  // cursor polling doesn't work on Wayland (security restrictions).
  // Instead, the sidebar renderer sends IPC when the drag area is hovered.
  // Main process shifts the content BrowserView accordingly.
  // --------------------------------------------------
  let toolbarCollapseTimer: ReturnType<typeof setTimeout> | null = null;
  ipcMain.on('toolbar:expand', () => {
    if (toolbarCollapseTimer) { clearTimeout(toolbarCollapseTimer); toolbarCollapseTimer = null; }
    tabManager.setToolbarExpanded(true);
  });
  ipcMain.on('toolbar:collapse', () => {
    if (toolbarCollapseTimer) return;
    toolbarCollapseTimer = setTimeout(() => {
      tabManager.setToolbarExpanded(false);
      toolbarCollapseTimer = null;
    }, 300);
  });

  // --------------------------------------------------
  // Sidebar Resize IPC
  // --------------------------------------------------

  ipcMain.on(IPC.SIDEBAR_RESIZE, (_e, width: number) => {
    compactMode.setResizing(true);

    tabManager.setSidebarWidth(width);
    const clampedWidth = tabManager.getSidebarWidth();
    compactMode.setBaseWidth(clampedWidth);

    if (compactMode.getMode() === 'hidden') {
      // Overlay mode: only resize the sidebar view, don't move content
      const { height } = mainWindow.getContentBounds();
      sidebarView.setBounds({ x: 0, y: 0, width: clampedWidth + 8, height });
    } else {
      // Expanded mode: resize both sidebar and content together
      tabManager.layoutWithSidebarWidth(clampedWidth);
    }

    sidebarView.webContents.send(IPC.SIDEBAR_WIDTH_CHANGED, clampedWidth);

    if ((ipcMain as any)._resizeIdleTimer) clearTimeout((ipcMain as any)._resizeIdleTimer);
    (ipcMain as any)._resizeIdleTimer = setTimeout(() => {
      compactMode.setResizing(false);
    }, 150);
  });

  // --------------------------------------------------
  // Glance IPC Handlers (Zen's killer feature)
  // --------------------------------------------------

  ipcMain.on('glance:open', (_e, data: { url: string; x: number; y: number }) => {
    glanceManager.open(data.url, data.x, data.y);
  });
  ipcMain.on('glance:close', () => glanceManager.close());
  ipcMain.on('glance:expand', () => glanceManager.expand());

  // --------------------------------------------------
  // Split View IPC Handlers (Helium + Zen combined)
  // --------------------------------------------------

  ipcMain.on('split:enter', (_e, data: { leftTabId: string; rightTabId?: string; direction?: string }) => {
    splitView.split(data.leftTabId, data.rightTabId, (data.direction as any) || 'horizontal');
  });
  ipcMain.on('split:exit', () => splitView.unsplit());
  ipcMain.on('split:toggle-direction', () => splitView.toggleDirection());
  ipcMain.on('split:swap', () => splitView.swapPanes());
  ipcMain.on('split:resize', (_e, data: { position: number }) => {
    splitView.handleDividerDrag(data.position);
  });

  // --------------------------------------------------
  // Privacy IPC
  // --------------------------------------------------

  ipcMain.on('privacy:toggle', () => {
    fingerprintGuard.setEnabled(!fingerprintGuard.isEnabled());
    sidebarView.webContents.send('privacy:state', {
      enabled: fingerprintGuard.isEnabled(),
    });
  });
  ipcMain.on('privacy:get-state', () => {
    sidebarView.webContents.send('privacy:state', {
      enabled: fingerprintGuard.isEnabled(),
    });
  });
}

// --------------------------------------------------
// App lifecycle
// --------------------------------------------------

app.on('ready', async () => {
  // Performance: Initialize AdBlocker and Database in parallel with each other
  // (AdBlocker fetches filter lists from network — don't block window creation on it)
  const adBlocker = new AdBlocker();
  database = new AppDatabase();

  // Start AdBlocker async, then open window immediately — tabs will be protected
  // by the time the user loads a real URL (AdBlocker is fast on second run via cache)
  const adBlockerReady = adBlocker.initialize();

  createWindow();

  // Wait in background — blocks are applied to the session once ready
  adBlockerReady.catch((err) => console.error('[Astra] AdBlocker failed:', err));

  app.on('before-quit', () => {
    tabManager?.saveSession();
    database?.close();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BaseWindow.getAllWindows().length === 0) createWindow();
});
