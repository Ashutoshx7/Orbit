import { BaseWindow, WebContentsView, Menu, clipboard } from 'electron';
import { ManagedTab, TabData, SessionTab, CONFIG, IPC } from '../types';
import { AppDatabase } from '../database/Database';
import { DownloadManager } from './DownloadManager';
import { getNewTabPageUrl } from '../pages/newtab';
import type { SpaceManager } from './SpaceManager';

type SidebarLayoutEasing = 'easeIn' | 'easeOut';

/**
 * TabManager — owns the lifecycle of all browser tabs.
 *
 * Performance optimizations:
 *   - O(1) tab lookups via Map index
 *   - Throttled IPC sends (max 1 per 100ms)
 *   - Smart layout swaps (only swap when active tab changes)
 *   - Cached new tab page URL
 */
export class TabManager {
  private tabs: ManagedTab[] = [];
  private readonly tabIndex: Map<string, ManagedTab> = new Map(); // O(1) lookups
  private activeTabId: string | null = null;
  private currentlyAttachedTabId: string | null = null; // Track what's actually in the DOM
  private tabCounter = 0;
  private onViewCreated: ((view: WebContentsView) => void) | null = null;
  private readonly downloadManager: DownloadManager;
  private readonly newTabPageUrl: string; // Cached — computed once

  // Throttle state for sendTabsToSidebar
  private sendPending = false;
  private sendTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly SEND_THROTTLE_MS = 100;
  private spaceManager: SpaceManager | null = null;
  private sidebarWidth: number = CONFIG.SIDEBAR_WIDTH;

  // Zen-style floating content card.
  // The VISUAL gap between sidebar and content is created by CSS padding
  // on the sidebar renderer, NOT by a gap between BrowserView bounds.
  // This eliminates GPU compositor desync during resize.
  private static readonly CONTENT_INSET = 8;
  private static readonly CONTENT_RADIUS = 10;

  // Zen-style toolbar reveal:
  // Controls strip z-indexed ABOVE content, BELOW sidebar.
  // Starts at CONTENT_INSET height (8px) — fills the gap above content.
  // Sidebar covers left portion, so only WORKSPACE top edge triggers hover.
  // On hover: height 8 → 36, covering content's top. Content never moves.
  private static readonly TOOLBAR_HEIGHT = 36;
  private static readonly ANIM_DURATION = 150; // ms — matches Zen's 0.15s ease-in-out
  private static readonly ANIM_FPS = 60;
  private toolbarExpanded = false;
  private animTimer: ReturnType<typeof setInterval> | null = null;
  private sidebarLayoutTimer: ReturnType<typeof setInterval> | null = null;
  private currentControlsH: number = TabManager.CONTENT_INSET; // starts at 8px (gap height)

  // Window controls strip — z-indexed ABOVE content, BELOW sidebar.
  private readonly controlsView: WebContentsView;

  constructor(
    private readonly mainWindow: BaseWindow,
    private readonly sidebarView: WebContentsView,
    private readonly database: AppDatabase,
    preloadPath: string,
  ) {
    this.downloadManager = new DownloadManager(sidebarView);
    this.newTabPageUrl = getNewTabPageUrl(); // Cache the data URL

    // Create window controls strip — NO preload needed.
    // IPC is handled via webContents.ipc on the main process side.
    this.controlsView = new WebContentsView({
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        sandbox: true,
      },
    });
    this.controlsView.setBackgroundColor(CONFIG.WINDOW.BG_COLOR);
    this.controlsView.webContents.loadURL(TabManager.buildControlsHTML());
    // Add at z-index 2 — ABOVE content (1), BELOW sidebar (added last = highest)
    this.mainWindow.contentView.addChildView(this.controlsView, 2);

    // Listen for IPC from controls strip (standard channels from preload)
    // The preload sends 'window:minimize', 'window:maximize', 'window:close',
    // 'toolbar:expand', 'toolbar:collapse' — all handled by global ipcMain handlers.

    // Fallback: also listen via webContents.ipc for custom channels
    this.controlsView.webContents.ipc.on('controls:hover-enter', () => this.setToolbarExpanded(true));
    this.controlsView.webContents.ipc.on('controls:hover-leave', () => {
      setTimeout(() => this.setToolbarExpanded(false), 300);
    });

    // After load, verify window.astra works. If not, inject handlers manually.
    this.controlsView.webContents.on('did-finish-load', () => {
      this.controlsView.webContents.executeJavaScript(`
        (function() {
          const a = window.astra;
          if (!a) {
            // Preload didn't load — log for debugging
            console.warn('[Astra Controls] window.astra not available');
            return;
          }
          // Wire up buttons
          const min = document.getElementById('min');
          const max = document.getElementById('max');
          const close = document.getElementById('close');
          if (min) min.onclick = () => a.minimizeWindow();
          if (max) max.onclick = () => a.maximizeWindow();
          if (close) close.onclick = () => a.closeWindow();

          // Hover detection for toolbar reveal
          document.body.addEventListener('mouseenter', () => a.toolbarExpand());
          document.body.addEventListener('mouseleave', () => a.toolbarCollapse());
        })();
      `).catch(() => { /* ignore script errors */ });
    });
  }

  /** Builds a data-URL with the window control buttons */
  private static buildControlsHTML(): string {
    const html = `<!DOCTYPE html>
<html><head><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    background: ${CONFIG.WINDOW.BG_COLOR};
    display: flex;
    align-items: center;
    justify-content: flex-end;
    height: 100vh;
    padding-right: 6px;
    font-family: sans-serif;
    -webkit-app-region: drag;
    overflow: hidden;
  }
  .btn {
    display: flex; align-items: center; justify-content: center;
    width: 32px; height: 28px; border: none;
    background: transparent; color: #888; cursor: pointer;
    border-radius: 5px; transition: background 0.12s, color 0.12s;
    -webkit-app-region: no-drag;
  }
  .btn:hover { background: rgba(255,255,255,0.1); color: #e0e0e0; }
  .btn.close:hover { background: #e81123; color: #fff; }
  .btn svg { width: 12px; height: 12px; }
</style></head><body>
  <button class="btn" id="min" title="Minimize">
    <svg viewBox="0 0 12 12"><path d="M2 6h8" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>
  </button>
  <button class="btn" id="max" title="Maximize">
    <svg viewBox="0 0 12 12"><rect x="2" y="2" width="8" height="8" rx="1" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>
  </button>
  <button class="btn close" id="close" title="Close">
    <svg viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>
  </button>
</body></html>`;
    return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
  }

  // --------------------------------------------------
  // Public API
  // --------------------------------------------------

  setOnViewCreated(cb: (view: WebContentsView) => void): void {
    this.onViewCreated = cb;
  }

  setSpaceManager(sm: SpaceManager): void {
    this.spaceManager = sm;
  }

  setSidebarWidth(width: number): void {
    this.sidebarWidth = Math.max(
      CONFIG.SIDEBAR_MIN_WIDTH,
      Math.min(CONFIG.SIDEBAR_MAX_WIDTH, width),
    );
  }

  getSidebarWidth(): number {
    return this.sidebarWidth;
  }

  createTab(url?: string, isPinned = false, spaceId?: string): ManagedTab {
    const id = this.nextId();
    const view = new WebContentsView();

    // Set dark background BEFORE page loads — prevents white flash during
    // resize compositor lag when sidebar shrinks and content hasn't moved yet.
    view.setBackgroundColor(CONFIG.WINDOW.BG_COLOR);

    // Performance: do NOT add to contentView yet — only attach when the tab becomes active.
    // Adding every tab immediately wastes GPU compositor memory for background tabs.
    // The view IS created so webContents starts loading in the background (preloading).
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 });

    const loadUrl = url || this.newTabPageUrl;
    view.webContents.loadURL(loadUrl);

    this.attachTabEvents(id, view);
    this.attachContextMenu(view);

    view.webContents.setWindowOpenHandler(({ url: linkUrl }) => {
      const newTab = this.createTab(linkUrl);
      this.switchToTab(newTab.id);
      return { action: 'deny' };
    });

    this.downloadManager.attachToView(view);

    const tab: ManagedTab = {
      id, view,
      title: 'New Tab',
      url: loadUrl,
      favicon: '🌐',
      isLoading: true,
      isSecure: false,
      isPinned,
      isHibernated: false,
      zoomLevel: 1.0,
      spaceId: spaceId || this.spaceManager?.getActiveSpaceId() || '',
    };

    // Insert pinned tabs at the start
    if (isPinned) {
      const firstUnpinned = this.tabs.findIndex(t => !t.isPinned);
      if (firstUnpinned === -1) this.tabs.push(tab);
      else this.tabs.splice(firstUnpinned, 0, tab);
    } else {
      this.tabs.push(tab);
    }

    // Add to index
    this.tabIndex.set(id, tab);

    this.onViewCreated?.(view);
    return tab;
  }

  switchToTab(tabId: string): void {
    const tab = this.findTab(tabId);
    if (!tab) return;

    this.activeTabId = tabId;

    // Wake hibernated tab on switch
    if (tab.isHibernated) {
      this.wakeTab(tab);
    }

    this.layoutViews();
    this.sidebarView.webContents.send(IPC.URL_CHANGED, tab.url);
    this.sidebarView.webContents.send(IPC.BOOKMARK_STATUS, this.database.isBookmarked(tab.url));
    this.sidebarView.webContents.send(IPC.ZOOM_CHANGED, Math.round(tab.zoomLevel * 100));
    this.scheduleSend();
  }

  layout(): void {
    this.layoutViews();
  }

  closeTab(tabId: string): void {
    const tab = this.findTab(tabId);
    if (!tab || tab.isPinned) return;

    const index = this.tabs.indexOf(tab);
    // View may not be attached if it was created but never activated — try/catch handles both cases
    try { this.mainWindow.contentView.removeChildView(tab.view); } catch { /* not attached, ok */ }

    if (this.currentlyAttachedTabId === tabId) {
      this.currentlyAttachedTabId = null;
    }

    tab.view.webContents.close();
    this.tabs.splice(index, 1);
    this.tabIndex.delete(tabId); // Remove from index

    if (this.activeTabId === tabId) {
      if (this.tabs.length > 0) {
        const newIndex = Math.min(index, this.tabs.length - 1);
        this.switchToTab(this.tabs[newIndex].id);
      } else {
        const newTab = this.createTab();
        this.switchToTab(newTab.id);
      }
    }

    this.scheduleSend();
  }

  // --------------------------------------------------
  // Navigation
  // --------------------------------------------------

  navigateActiveTab(url: string): void {
    this.getActiveTab()?.view.webContents.loadURL(url);
  }

  goBack(): void {
    const tab = this.getActiveTab();
    if (tab?.view.webContents.navigationHistory.canGoBack()) {
      tab.view.webContents.navigationHistory.goBack();
    }
  }

  goForward(): void {
    const tab = this.getActiveTab();
    if (tab?.view.webContents.navigationHistory.canGoForward()) {
      tab.view.webContents.navigationHistory.goForward();
    }
  }

  reload(): void {
    this.getActiveTab()?.view.webContents.reload();
  }

  nextTab(): void {
    if (this.tabs.length <= 1) return;
    const i = this.tabs.findIndex(t => t.id === this.activeTabId);
    this.switchToTab(this.tabs[(i + 1) % this.tabs.length].id);
  }

  previousTab(): void {
    if (this.tabs.length <= 1) return;
    const i = this.tabs.findIndex(t => t.id === this.activeTabId);
    this.switchToTab(this.tabs[(i - 1 + this.tabs.length) % this.tabs.length].id);
  }

  // --------------------------------------------------
  // Pin/Unpin
  // --------------------------------------------------

  pinTab(tabId: string): void {
    const tab = this.findTab(tabId);
    if (!tab || tab.isPinned) return;

    tab.isPinned = true;
    const index = this.tabs.indexOf(tab);
    this.tabs.splice(index, 1);
    const firstUnpinned = this.tabs.findIndex(t => !t.isPinned);
    if (firstUnpinned === -1) this.tabs.push(tab);
    else this.tabs.splice(firstUnpinned, 0, tab);

    this.scheduleSend();
  }

  unpinTab(tabId: string): void {
    const tab = this.findTab(tabId);
    if (!tab || !tab.isPinned) return;

    tab.isPinned = false;
    const index = this.tabs.indexOf(tab);
    this.tabs.splice(index, 1);
    const firstUnpinned = this.tabs.findIndex(t => !t.isPinned);
    if (firstUnpinned === -1) this.tabs.push(tab);
    else this.tabs.splice(firstUnpinned, 0, tab);

    this.scheduleSend();
  }

  reorderTabs(oldIndex: number, newIndex: number): void {
    if (oldIndex < 0 || oldIndex >= this.tabs.length) return;
    if (newIndex < 0 || newIndex >= this.tabs.length) return;
    if (oldIndex === newIndex) return;

    const [tab] = this.tabs.splice(oldIndex, 1);
    this.tabs.splice(newIndex, 0, tab);

    this.scheduleSend();
  }

  // --------------------------------------------------
  // Zoom
  // --------------------------------------------------

  zoomIn(): void {
    const tab = this.getActiveTab();
    if (!tab || tab.zoomLevel >= CONFIG.ZOOM_MAX) return;
    tab.zoomLevel = Math.min(tab.zoomLevel + CONFIG.ZOOM_STEP, CONFIG.ZOOM_MAX);
    tab.view.webContents.setZoomFactor(tab.zoomLevel);
    this.sidebarView.webContents.send(IPC.ZOOM_CHANGED, Math.round(tab.zoomLevel * 100));
  }

  zoomOut(): void {
    const tab = this.getActiveTab();
    if (!tab || tab.zoomLevel <= CONFIG.ZOOM_MIN) return;
    tab.zoomLevel = Math.max(tab.zoomLevel - CONFIG.ZOOM_STEP, CONFIG.ZOOM_MIN);
    tab.view.webContents.setZoomFactor(tab.zoomLevel);
    this.sidebarView.webContents.send(IPC.ZOOM_CHANGED, Math.round(tab.zoomLevel * 100));
  }

  zoomReset(): void {
    const tab = this.getActiveTab();
    if (!tab) return;
    tab.zoomLevel = 1.0;
    tab.view.webContents.setZoomFactor(1.0);
    this.sidebarView.webContents.send(IPC.ZOOM_CHANGED, 100);
  }

  // --------------------------------------------------
  // Find in page
  // --------------------------------------------------

  findInPage(text: string): void {
    const tab = this.getActiveTab();
    if (!tab || !text) return;
    tab.view.webContents.findInPage(text);
  }

  stopFind(): void {
    this.getActiveTab()?.view.webContents.stopFindInPage('clearSelection');
  }

  // --------------------------------------------------
  // Session restore
  // --------------------------------------------------

  saveSession(): void {
    const sessionTabs: SessionTab[] = this.tabs
      .filter(t => !t.url.startsWith('data:') && !t.url.startsWith('astra://'))
      .map((t, i) => ({
        url: t.url, title: t.title, isPinned: t.isPinned, position: i,
        spaceId: t.spaceId,
      }));
    this.database.saveSession(sessionTabs);
    console.log(`[Astra] 💾 Session saved: ${sessionTabs.length} tabs`);
  }

  restoreSession(): boolean {
    const sessionTabs = this.database.restoreSession();
    if (sessionTabs.length === 0) return false;

    for (const st of sessionTabs) {
      this.createTab(st.url, st.isPinned, st.spaceId || undefined);
    }

    if (this.tabs.length > 0) this.switchToTab(this.tabs[0].id);
    console.log(`[Astra] 🔄 Session restored: ${sessionTabs.length} tabs`);
    return true;
  }

  // --------------------------------------------------
  // State getters
  // --------------------------------------------------

  getActiveTabId(): string | null { return this.activeTabId; }
  getActiveTabUrl(): string { return this.getActiveTab()?.url || ''; }
  getActiveTabTitle(): string { return this.getActiveTab()?.title || ''; }
  getAllViews(): WebContentsView[] { return this.tabs.map(t => t.view); }
  getAllTabIds(): string[] { return this.tabs.map(t => t.id); }

  /** Public tab lookup (for SplitViewManager) */
  findTabById(id: string): ManagedTab | undefined {
    return this.tabIndex.get(id);
  }

  /** Get tabs belonging to a specific workspace (for SpaceManager) */
  getTabsForSpace(spaceId: string): ManagedTab[] {
    return this.tabs.filter(t => t.spaceId === spaceId || t.isPinned);
  }

  /** Move all tabs from one workspace to another (used during space deletion) */
  moveTabsToSpace(fromSpaceId: string, toSpaceId: string): void {
    for (const tab of this.tabs) {
      if (tab.spaceId === fromSpaceId) {
        tab.spaceId = toSpaceId;
      }
    }
    this.scheduleSend();
  }

  /**
   * Hibernate a tab — crash its renderer to reclaim memory (Helium pattern).
   * The URL and scroll position are saved so the tab can be restored on click.
   */
  hibernateTab(tabId: string): void {
    const tab = this.findTab(tabId);
    if (!tab || tab.id === this.activeTabId || tab.isHibernated) return;

    // Don't hibernate if media is playing
    if (tab.view.webContents.isCurrentlyAudible()) return;

    try {
      tab.view.webContents.forcefullyCrashRenderer();
      tab.isHibernated = true;
      tab.isLoading = false;
      this.scheduleSend();
      console.log(`[Astra] 🌙 Hibernated tab: ${tab.title}`);
    } catch (err) {
      console.error('[Astra] Hibernate failed:', err);
    }
  }

  /** Wake a hibernated tab by reloading its URL */
  private wakeTab(tab: ManagedTab): void {
    if (!tab.isHibernated) return;
    tab.isHibernated = false;
    tab.view.webContents.loadURL(tab.url);
    console.log(`[Astra] ☀️ Woke tab: ${tab.title}`);
  }

  /**
   * Send full tab state to sidebar.
   * Called directly only when explicitly requested (e.g. IPC.REQUEST_TABS).
   * For internal use, prefer `scheduleSend()` which throttles.
   */
  sendTabsToSidebar(): void {
    const activeSpaceId = this.spaceManager?.getActiveSpaceId() || '';

    // Only send tabs for the active workspace + pinned (essential) tabs
    const visibleTabs = activeSpaceId
      ? this.tabs.filter(t => t.spaceId === activeSpaceId || t.isPinned)
      : this.tabs;

    const tabData: TabData[] = visibleTabs.map(t => ({
      id: t.id, title: t.title, url: t.url, favicon: t.favicon,
      isLoading: t.isLoading, isSecure: t.isSecure,
      isPinned: t.isPinned, isHibernated: t.isHibernated,
      zoomLevel: t.zoomLevel, spaceId: t.spaceId,
    }));
    this.sidebarView.webContents.send(IPC.TABS_UPDATED, {
      tabs: tabData,
      activeTabId: this.activeTabId,
      activeSpaceId,
    });
    this.sendPending = false;
  }

  // --------------------------------------------------
  // Private: Performance-critical internals
  // --------------------------------------------------

  /**
   * Throttled send — coalesces multiple rapid state changes into one IPC message.
   * Without this, a single page load would send 5-8 IPC messages.
   */
  private scheduleSend(): void {
    if (this.sendTimer) return; // Already scheduled

    this.sendPending = true;
    this.sendTimer = setTimeout(() => {
      this.sendTimer = null;
      if (this.sendPending) {
        this.sendTabsToSidebar();
      }
    }, TabManager.SEND_THROTTLE_MS);
  }

  private nextId(): string { return `tab-${++this.tabCounter}`; }

  /** O(1) tab lookup via Map index */
  private findTab(id: string): ManagedTab | undefined {
    return this.tabIndex.get(id);
  }

  private getActiveTab(): ManagedTab | undefined {
    return this.activeTabId ? this.findTab(this.activeTabId) : undefined;
  }

  private attachTabEvents(id: string, view: WebContentsView): void {
    view.webContents.on('page-title-updated', (_e, title) => {
      const tab = this.findTab(id);
      if (tab) {
        tab.title = title;
        tab.url = view.webContents.getURL();
        this.database.recordVisit(tab.url, title);
        this.scheduleSend(); // Throttled, not direct
      }
    });

    view.webContents.on('page-favicon-updated', (_e, favicons) => {
      const tab = this.findTab(id);
      if (tab && favicons.length > 0) {
        tab.favicon = favicons[0];
        this.scheduleSend();
      }
    });

    view.webContents.on('did-navigate', (_e, newUrl) => {
      const tab = this.findTab(id);
      if (tab) {
        tab.url = newUrl;
        tab.isSecure = newUrl.startsWith('https://');
        this.scheduleSend();
      }
      if (id === this.activeTabId) {
        this.sidebarView.webContents.send(IPC.URL_CHANGED, newUrl);
        this.sidebarView.webContents.send(IPC.BOOKMARK_STATUS, this.database.isBookmarked(newUrl));
      }
    });

    view.webContents.on('did-navigate-in-page', (_e, newUrl) => {
      const tab = this.findTab(id);
      if (tab) tab.url = newUrl;
      if (id === this.activeTabId) {
        this.sidebarView.webContents.send(IPC.URL_CHANGED, newUrl);
      }
    });

    view.webContents.on('did-start-loading', () => {
      const tab = this.findTab(id);
      if (tab) { tab.isLoading = true; this.scheduleSend(); }
    });

    view.webContents.on('did-stop-loading', () => {
      const tab = this.findTab(id);
      if (tab) { tab.isLoading = false; this.scheduleSend(); }
    });

    view.webContents.on('found-in-page', (_e, result) => {
      this.sidebarView.webContents.send(IPC.FIND_RESULT, {
        activeMatchOrdinal: result.activeMatchOrdinal,
        matches: result.matches,
      });
    });
  }

  private attachContextMenu(view: WebContentsView): void {
    view.webContents.on('context-menu', (_e, params) => {
      const items: Electron.MenuItemConstructorOptions[] = [];

      if (params.linkURL) {
        items.push(
          {
            label: 'Open Link in New Tab', click: () => {
              const t = this.createTab(params.linkURL);
              this.switchToTab(t.id);
            }
          },
          { label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) },
          { type: 'separator' },
        );
      }

      if (params.selectionText) {
        items.push({ label: 'Copy', role: 'copy' }, { type: 'separator' });
      }

      items.push(
        { label: 'Back', enabled: view.webContents.navigationHistory.canGoBack(), click: () => view.webContents.navigationHistory.goBack() },
        { label: 'Forward', enabled: view.webContents.navigationHistory.canGoForward(), click: () => view.webContents.navigationHistory.goForward() },
        { label: 'Reload', click: () => view.webContents.reload() },
        { type: 'separator' },
        { label: 'Zoom In', click: () => this.zoomIn() },
        { label: 'Zoom Out', click: () => this.zoomOut() },
        { label: 'Reset Zoom', click: () => this.zoomReset() },
      );

      Menu.buildFromTemplate(items).popup();
    });
  }

  /**
   * Smart layout — only swaps views when the active tab actually changes.
   *
   * LAYOUT STRATEGY (eliminates GPU compositor desync):
   * - Sidebar BrowserView width = sidebarWidth + INSET
   *   (extends into the visual gap area; CSS padding-right creates the gap)
   * - Content BrowserView x = sidebarWidth + INSET
   *   (starts exactly where sidebar ends — ZERO gap between views)
   * - Content is inset from top/right/bottom window edges
   */
  private layoutViews(): void {
    const { width, height } = this.mainWindow.getContentBounds();
    const g = TabManager.CONTENT_INSET;

    // Sidebar always at y=0, no shifting
    this.sidebarView.setBounds({ x: 0, y: 0, width: this.sidebarWidth + g, height });

    // Controls strip — covers content area only (sidebar hides the left portion via z-order)
    this.controlsView.setBounds({
      x: this.sidebarWidth + g,
      y: 0,
      width: width - this.sidebarWidth - g * 2,
      height: this.currentControlsH,
    });

    const activeTab = this.getActiveTab();

    if (this.currentlyAttachedTabId !== this.activeTabId) {
      if (this.currentlyAttachedTabId) {
        const prevTab = this.findTab(this.currentlyAttachedTabId);
        if (prevTab) {
          try { this.mainWindow.contentView.removeChildView(prevTab.view); } catch { /* ok */ }
        }
      }
      if (activeTab) {
        // Index 0 — bottom of stack (below controls at 2, below sidebar)
        this.mainWindow.contentView.addChildView(activeTab.view, 0);
      }
      this.currentlyAttachedTabId = this.activeTabId;
    }

    if (activeTab) {
      // Content NEVER moves — always at y=g. Controls overlay its top edge on hover.
      activeTab.view.setBounds({
        x: this.sidebarWidth + g,
        y: g,
        width: width - this.sidebarWidth - g * 2,
        height: height - g * 2,
      });
      try { activeTab.view.setBorderRadius(TabManager.CONTENT_RADIUS); } catch { /* older Electron */ }
    }
  }

  /**
   * Layout with a custom sidebar width (resize IPC / CompactMode).
   *
   * DIRECTION-AWARE setBounds order:
   * - SHRINKING: move content LEFT first (slides under sidebar via z-order),
   *   then shrink sidebar → content is already in position, no gap visible.
   * - EXPANDING: grow sidebar first (covers the gap via z-order),
   *   then move content RIGHT → sidebar covers content's old position.
   */
  layoutWithSidebarWidth(sidebarWidth: number): void {
    this.cancelSidebarLayoutAnimation();

    const oldWidth = this.sidebarWidth;
    // Allow 0 for auto-hide; only clamp to min when sidebar is visible
    this.sidebarWidth = this.clampSidebarWidth(sidebarWidth);
    const { width, height } = this.mainWindow.getContentBounds();
    const g = TabManager.CONTENT_INSET;
    const shrinking = this.sidebarWidth < oldWidth;

    if (shrinking) {
      this.layoutContentForSidebarWidth(this.sidebarWidth, width, height);
      this.sidebarView.setBounds({ x: 0, y: 0, width: this.sidebarWidth + g, height });
    } else {
      this.sidebarView.setBounds({ x: 0, y: 0, width: this.sidebarWidth + g, height });
      this.layoutContentForSidebarWidth(this.sidebarWidth, width, height);
    }
  }

  /**
   * Animate only the content/controls layout. CompactModeManager owns the
   * sidebar BrowserView bounds during dock/undock so the two animations do not
   * fight each other.
   */
  animateContentForSidebarWidth(
    sidebarWidth: number,
    durationMs: number,
    easing: SidebarLayoutEasing = 'easeOut',
  ): void {
    this.cancelSidebarLayoutAnimation();

    const targetWidth = this.clampSidebarWidth(sidebarWidth);
    const startWidth = this.sidebarWidth;
    const deltaWidth = targetWidth - startWidth;

    if (durationMs <= 0 || deltaWidth === 0) {
      this.applyContentSidebarWidth(targetWidth);
      return;
    }

    const frameInterval = 1000 / TabManager.ANIM_FPS;
    const startedAt = Date.now();

    this.sidebarLayoutTimer = setInterval(() => {
      const t = Math.min((Date.now() - startedAt) / durationMs, 1);
      const eased = this.easeSidebarLayout(t, easing);
      this.applyContentSidebarWidth(startWidth + deltaWidth * eased);

      if (t >= 1) {
        this.cancelSidebarLayoutAnimation();
        this.applyContentSidebarWidth(targetWidth);
      }
    }, frameInterval);
  }

  private clampSidebarWidth(width: number): number {
    if (width <= 0) return 0;
    return Math.max(CONFIG.SIDEBAR_MIN_WIDTH, Math.min(CONFIG.SIDEBAR_MAX_WIDTH, Math.round(width)));
  }

  private applyContentSidebarWidth(sidebarWidth: number): void {
    const { width, height } = this.mainWindow.getContentBounds();
    this.sidebarWidth = this.clampSidebarWidth(sidebarWidth);
    this.layoutContentForSidebarWidth(this.sidebarWidth, width, height);
  }

  private layoutContentForSidebarWidth(sidebarWidth: number, width: number, height: number): void {
    const g = TabManager.CONTENT_INSET;
    const contentX = sidebarWidth + g;
    const contentW = Math.max(0, width - sidebarWidth - g * 2);
    const contentH = Math.max(0, height - g * 2);

    this.controlsView.setBounds({
      x: contentX,
      y: 0,
      width: contentW,
      height: this.currentControlsH,
    });

    const activeTab = this.getActiveTab();
    if (activeTab) {
      activeTab.view.setBounds({
        x: contentX,
        y: g,
        width: contentW,
        height: contentH,
      });
      try { activeTab.view.setBorderRadius(TabManager.CONTENT_RADIUS); } catch { /* older Electron */ }
    }
  }

  private cancelSidebarLayoutAnimation(): void {
    if (!this.sidebarLayoutTimer) return;
    clearInterval(this.sidebarLayoutTimer);
    this.sidebarLayoutTimer = null;
  }

  private easeSidebarLayout(t: number, easing: SidebarLayoutEasing): number {
    if (easing === 'easeIn') return t * t;
    return 1 - Math.pow(1 - t, 3);
  }

  /**
   * Zen-style toolbar reveal — SMOOTH animated.
   *
   * Content and sidebar NEVER move. Only controlsView height animates:
   * CONTENT_INSET (8px) → TOOLBAR_HEIGHT (36px), overlapping content top.
   * 150ms ease-in-out matches Zen's --zen-hidden-toolbar-transition.
   */
  setToolbarExpanded(expanded: boolean): void {
    if (this.toolbarExpanded === expanded) return;
    this.toolbarExpanded = expanded;

    // Cancel any in-progress animation
    if (this.animTimer) {
      clearInterval(this.animTimer);
      this.animTimer = null;
    }

    const g = TabManager.CONTENT_INSET;
    const T = TabManager.TOOLBAR_HEIGHT;

    const targetH = expanded ? T : g;
    const startH = this.currentControlsH;
    const deltaH = targetH - startH;

    const frameInterval = 1000 / TabManager.ANIM_FPS;
    const totalFrames = Math.ceil(TabManager.ANIM_DURATION / frameInterval);
    let frame = 0;
    this.animTimer = setInterval(() => {
      frame++;
      const t = Math.min(frame / totalFrames, 1);
      const eased = t < 0.5
        ? 2 * t * t
        : 1 - Math.pow(-2 * t + 2, 2) / 2;

      const h = Math.round(startH + deltaH * eased);
      const { width } = this.mainWindow.getContentBounds();
      const contentX = this.sidebarWidth + g;
      const contentW = Math.max(0, width - this.sidebarWidth - g * 2);
      this.currentControlsH = h;
      this.controlsView.setBounds({ x: contentX, y: 0, width: contentW, height: h });

      if (frame >= totalFrames) {
        const timer = this.animTimer;
        if (timer) clearInterval(timer);
        this.animTimer = null;
        this.currentControlsH = targetH;
        const { width } = this.mainWindow.getContentBounds();
        const contentX = this.sidebarWidth + g;
        const contentW = Math.max(0, width - this.sidebarWidth - g * 2);
        this.controlsView.setBounds({ x: contentX, y: 0, width: contentW, height: targetH });
      }
    }, frameInterval);

    this.sidebarView.webContents.send('toolbar:expanded', expanded);
  }
}
