import React, { useState, useCallback, useMemo, useRef } from 'react';

// Types
import type {
  Tab, SpaceData, UrlSuggestion, Bookmark, HistoryEntry,
  DownloadItem, FindResult, CompactState, GlanceState,
  SpaceContextMenu as SpaceContextMenuType, PanelMode, SettingsSubPanel,
} from './types/renderer';

// Hooks
import { useAstraListeners } from './hooks/useAstraListeners';
import { useDragAndDrop } from './hooks/useDragAndDrop';
import { useSidebarResize } from './hooks/useSidebarResize';

// Components
import UrlBar from './components/UrlBar';
import PinnedTabs from './components/PinnedTabs';
import FindBar from './components/FindBar';
import TabList from './components/TabList';
import SpacesPanel from './components/SpacesPanel';
import SettingsPanel from './components/SettingsPanel';
import DownloadsSection from './components/DownloadsSection';
import BottomBar from './components/BottomBar';
import SpaceContextMenu from './components/SpaceContextMenu';

// --------------------------------------------------
// App — lean orchestrator
// --------------------------------------------------

const App: React.FC = () => {
  // ── Tab & navigation state ────────────────────────
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState('');
  const [urlInput, setUrlInput] = useState('');
  const [isBookmarked, setIsBookmarked] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(100);

  // ── Search suggestions ────────────────────────────
  const [suggestions, setSuggestions] = useState<UrlSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);

  // ── Downloads / bookmarks / history ──────────────
  const [downloads, setDownloads] = useState<DownloadItem[]>([]);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  // ── Find-in-page ──────────────────────────────────
  const [showFindBar, setShowFindBar] = useState(false);
  const [findText, setFindText] = useState('');
  const [findResult, setFindResult] = useState<FindResult | null>(null);

  // ── Spaces ────────────────────────────────────────
  const [spaces, setSpaces] = useState<SpaceData[]>([]);
  const [activeSpaceId, setActiveSpaceId] = useState('');

  // ── UI state ──────────────────────────────────────
  const [panelMode, setPanelMode] = useState<PanelMode>('tabs');
  const [settingsSubPanel, setSettingsSubPanel] = useState<SettingsSubPanel>('main');
  const [compactState, setCompactState] = useState<CompactState>({ mode: 'expanded', expanded: true, sidebarVisible: true, sidebarWidth: 300 });
  const [glanceState, setGlanceState] = useState<GlanceState>({ active: false, url: '' });
  const [urlCopiedToast, setUrlCopiedToast] = useState(false);
  const [spaceContextMenu, setSpaceContextMenu] = useState<SpaceContextMenuType | null>(null);

  // ── Refs ──────────────────────────────────────────
  const urlInputRef = useRef<HTMLInputElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Hooks ─────────────────────────────────────────
  const { sidebarRef, isResizing, handleResizeMouseDown } = useSidebarResize();
  const {
    handleDragStart, handleDragOver, handleDrop,
    handleDropToPinZone, handleDropToUnpinZone,
  } = useDragAndDrop();

  useAstraListeners({
    setTabs,
    setActiveTabId,
    setUrlInput,
    setIsBookmarked,
    setSuggestions,
    setShowSuggestions,
    setBookmarks,
    setHistory,
    setZoomLevel,
    setShowFindBar,
    setFindResult,
    setDownloads,
    setSpaces,
    setActiveSpaceId,
    setUrlCopiedToast,
    setCompactState,
    setGlanceActive: (active, url = '') => setGlanceState({ active, url }),
    urlInputRef,
    findInputRef,
  });

  // ── Derived state ─────────────────────────────────
  const activeTab = useMemo(() => tabs.find((t) => t.id === activeTabId), [tabs, activeTabId]);
  const pinnedTabs = useMemo(
    () => tabs.map((t, i) => ({ ...t, originalIndex: i })).filter((t) => t.isPinned),
    [tabs]
  );
  const unpinnedTabs = useMemo(
    () => tabs.map((t, i) => ({ ...t, originalIndex: i })).filter((t) => !t.isPinned),
    [tabs]
  );
  const activeSpace = useMemo(
    () => spaces.find((space) => space.id === activeSpaceId),
    [spaces, activeSpaceId]
  );

  // ── Handlers ──────────────────────────────────────
  const handleNavigate = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    window.astra.navigate(urlInput);
    setShowSuggestions(false);
    urlInputRef.current?.blur();
  }, [urlInput]);

  const handleUrlChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setUrlInput(val);
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      if (val.length >= 2) window.astra.searchSuggestions(val);
      else { setSuggestions([]); setShowSuggestions(false); }
    }, 300);
  }, []);

  const handleSuggestionPick = useCallback((url: string) => {
    setUrlInput(url);
    window.astra.navigate(url);
    setShowSuggestions(false);
  }, []);

  const handleToggleBookmark = useCallback(() => {
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab) return;
    if (isBookmarked) window.astra.removeBookmark(tab.url);
    else window.astra.addBookmark(tab.url, tab.title);
  }, [tabs, activeTabId, isBookmarked]);

  const closeFindBar = useCallback(() => {
    setShowFindBar(false);
    setFindText('');
    setFindResult(null);
    window.astra.stopFind();
  }, []);

  const handleFindTextChange = useCallback((text: string) => {
    setFindText(text);
    if (text) window.astra.findInPage(text);
  }, []);

  const setMode = useCallback((mode: PanelMode) => {
    if (mode === 'bookmarks') window.astra.getBookmarks();
    if (mode === 'history') window.astra.getHistory();
    setPanelMode((prev) => (prev === mode ? 'tabs' : mode));
  }, []);

  const switchTab = useCallback((id: string) => window.astra.switchTab(id), []);
  const pinTab = useCallback((id: string) => window.astra.pinTab(id), []);
  const unpinTab = useCallback((id: string) => window.astra.unpinTab(id), []);
  const closeTab = useCallback((id: string) => window.astra.closeTab(id), []);

  // Sidebar CSS classes driven by compactState from main process
  const { expanded, sidebarVisible, animating } = compactState;

  const sidebarClasses = [
    'sidebar',
    !expanded && !sidebarVisible && !animating ? 'sidebar-hidden' : '',
    animating === 'hiding' ? 'sidebar-sliding-out' : '',
    !expanded && sidebarVisible && animating !== 'hiding' ? 'sidebar-overlay' : '',
    animating === 'showing' ? 'sidebar-sliding-in' : '',
  ].filter(Boolean).join(' ');

  // Edge hover handlers
  const handleMouseEnter = useCallback(() => {
    // When hidden: trigger overlay. When overlay visible: cancel pending hide.
    if (!expanded) window.astra.edgeEnter();
  }, [expanded]);

  const handleMouseLeave = useCallback(() => {
    if (!expanded && sidebarVisible) window.astra.edgeLeave();
  }, [expanded, sidebarVisible]);

  // --------------------------------------------------
  // Render
  // --------------------------------------------------
  return (
    <div
      className={sidebarClasses}
      style={{
        '--active-space-color': activeSpace?.color || '#4f52ff',
      } as React.CSSProperties}
      ref={sidebarRef}
      onClick={() => setSpaceContextMenu(null)}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* Drag handle for window moving */}
      <div className="sidebar-drag-handle" />

      {/* URL bar + toolbar */}
      <UrlBar
        activeTab={activeTab}
        urlInput={urlInput}
        zoomLevel={zoomLevel}
        isBookmarked={isBookmarked}
        suggestions={suggestions}
        showSuggestions={showSuggestions}
        onNavigate={handleNavigate}
        onUrlChange={handleUrlChange}
        onSuggestionPick={handleSuggestionPick}
        onToggleBookmark={handleToggleBookmark}
        onShowSuggestions={setShowSuggestions}
        urlInputRef={urlInputRef}
      />

      {/* Pinned tabs */}
      {panelMode === 'tabs' && (
        <PinnedTabs
          pinnedTabs={pinnedTabs}
          activeTabId={activeTabId}
          onSwitch={switchTab}
          onUnpin={unpinTab}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onDropToPinZone={handleDropToPinZone}
        />
      )}

      {/* Find bar */}
      {showFindBar && (
        <FindBar
          findText={findText}
          findResult={findResult}
          onTextChange={handleFindTextChange}
          onClose={closeFindBar}
          findInputRef={findInputRef}
        />
      )}

      {/* Page loading bar */}
      {activeTab?.isLoading && (
        <div className="loading-bar">
          <div className="loading-bar-progress" />
        </div>
      )}

      {/* Main panel */}
      <div className="panel-container">
        {panelMode === 'tabs' && (
          <TabList
            unpinnedTabs={unpinnedTabs}
            activeTabId={activeTabId}
            onSwitch={switchTab}
            onPin={pinTab}
            onClose={closeTab}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            onDropToUnpinZone={handleDropToUnpinZone}
          />
        )}
        {panelMode === 'spaces' && (
          <SpacesPanel
            spaces={spaces}
            tabs={tabs}
            activeSpaceId={activeSpaceId}
            onSwitchSpace={(id) => { window.astra.switchSpace(id); setPanelMode('tabs'); }}
            onCreateSpace={() => window.astra.createSpace({ name: '', color: '', icon: '' })}
          />
        )}
        {panelMode === 'settings' && (
          <SettingsPanel
            subPanel={settingsSubPanel}
            bookmarks={bookmarks}
            history={history}
            onSubPanel={setSettingsSubPanel}
            onNavigate={(url) => { window.astra.navigate(url); setPanelMode('tabs'); }}
          />
        )}
      </div>

      {/* Downloads */}
      <DownloadsSection downloads={downloads} />

      {/* Bottom bar */}
      <BottomBar
        spaces={spaces}
        activeSpaceId={activeSpaceId}
        panelMode={panelMode}
        onOpenSettings={() => { setSettingsSubPanel('main'); setMode('settings'); }}
        onSwitchSpace={window.astra.switchSpace}
        onSpaceContextMenu={(e, spaceId) =>
          setSpaceContextMenu({ x: e.clientX, y: e.clientY, spaceId })
        }
        onCreateSpace={() => window.astra.createSpace({ name: '', color: '', icon: '' })}
      />

      {/* Space context menu */}
      {spaceContextMenu && (
        <SpaceContextMenu
          x={spaceContextMenu.x}
          y={spaceContextMenu.y}
          spaceId={spaceContextMenu.spaceId}
          spaces={spaces}
          onClose={() => setSpaceContextMenu(null)}
        />
      )}

      {/* Toasts */}
      {urlCopiedToast && (
        <div className="url-copied-toast">✓ URL copied to clipboard</div>
      )}



      {/* Glance overlay */}
      {glanceState.active && (
        <div className="glance-overlay-bar">
          <span className="glance-url">{glanceState.url}</span>
          <button className="glance-expand" onClick={() => window.astra.expandGlance()}>
            ⬆ Open as Tab
          </button>
          <button onClick={() => window.astra.closeGlance()}>✕ Close</button>
        </div>
      )}

      {/* Sidebar resize handle */}
      <div
        className={`sidebar-resize-handle ${isResizing ? 'active' : ''}`}
        onPointerDown={handleResizeMouseDown}
      />
    </div>
  );
};

export default App;
