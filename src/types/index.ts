import { WebContentsView } from 'electron';

// --------------------------------------------------
// Tab Types
// --------------------------------------------------

export interface ManagedTab {
  readonly id: string;
  readonly view: WebContentsView;
  title: string;
  url: string;
  favicon: string;
  isLoading: boolean;
  isSecure: boolean;
  isPinned: boolean;
  isHibernated: boolean;
  zoomLevel: number;
  spaceId: string;
}

export interface TabData {
  readonly id: string;
  title: string;
  url: string;
  favicon: string;
  isLoading: boolean;
  isSecure: boolean;
  isPinned: boolean;
  isHibernated: boolean;
  zoomLevel: number;
  spaceId: string;
}

export interface TabsUpdatedPayload {
  tabs: TabData[];
  activeTabId: string | null;
  activeSpaceId: string;
}

/** Tab data saved to SQLite for session restore */
export interface SessionTab {
  url: string;
  title: string;
  isPinned: boolean;
  position: number;
  spaceId: string;
}

// --------------------------------------------------
// Workspaces (inspired by Zen Browser's Spaces)
// --------------------------------------------------

export interface Space {
  readonly id: string;
  name: string;
  color: string;
  icon: string;
  position: number;
  createdAt: number;
}

export interface SpaceData {
  readonly id: string;
  name: string;
  color: string;
  icon: string;
  position: number;
}

// --------------------------------------------------
// History & Bookmarks
// --------------------------------------------------

export interface HistoryEntry {
  id: number;
  url: string;
  title: string;
  visitCount: number;
  lastVisitedAt: number;
}

export interface Bookmark {
  id: number;
  url: string;
  title: string;
  createdAt: number;
}

export interface DownloadItem {
  id: string;
  filename: string;
  url: string;
  totalBytes: number;
  receivedBytes: number;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
}

export interface UrlSuggestion {
  url: string;
  title: string;
  type: 'history' | 'bookmark';
}

// --------------------------------------------------
// IPC Channels
// --------------------------------------------------

export const IPC = {
  // Sidebar → Main
  NAVIGATE: 'navigate',
  GO_BACK: 'go-back',
  GO_FORWARD: 'go-forward',
  REFRESH: 'refresh',
  NEW_TAB: 'new-tab',
  CLOSE_TAB: 'close-tab',
  SWITCH_TAB: 'switch-tab',
  REQUEST_TABS: 'request-tabs',
  SEARCH_SUGGESTIONS: 'search-suggestions',
  ADD_BOOKMARK: 'add-bookmark',
  REMOVE_BOOKMARK: 'remove-bookmark',
  GET_BOOKMARKS: 'get-bookmarks',
  PIN_TAB: 'pin-tab',
  UNPIN_TAB: 'unpin-tab',
  FIND_IN_PAGE: 'find-in-page',
  FIND_NEXT: 'find-next',
  FIND_STOP: 'find-stop',

  CLEAR_HISTORY: 'clear-history',
  UPDATE_SETTINGS: 'update-settings',
  GET_HISTORY: 'get-history',
  REORDER_TABS: 'reorder-tabs',

  // Workspace IPC (Sidebar → Main)
  SPACE_SWITCH: 'space:switch',
  SPACE_CREATE: 'space:create',
  SPACE_DELETE: 'space:delete',
  SPACE_RENAME: 'space:rename',
  SPACE_REORDER: 'space:reorder',
  SPACE_UPDATE_COLOR: 'space:update-color',
  REQUEST_SPACES: 'request-spaces',

  // Hibernate
  HIBERNATE_TAB: 'hibernate-tab',

  // Main → Sidebar
  TABS_UPDATED: 'tabs-updated',
  URL_CHANGED: 'url-changed',
  FOCUS_URL_BAR: 'focus-url-bar',
  SUGGESTIONS_RESULT: 'suggestions-result',
  BOOKMARKS_RESULT: 'bookmarks-result',
  HISTORY_RESULT: 'history-result',
  BOOKMARK_STATUS: 'bookmark-status',
  DOWNLOAD_UPDATED: 'download-updated',
  FIND_RESULT: 'find-result',
  SHOW_FIND_BAR: 'show-find-bar',
  ZOOM_CHANGED: 'zoom-changed',
  SPACES_UPDATED: 'spaces-updated',
  SIDEBAR_RESIZE: 'sidebar:resize',
  SIDEBAR_WIDTH_CHANGED: 'sidebar:width-changed',
} as const;

// --------------------------------------------------
// Configuration
// --------------------------------------------------

export const CONFIG = {
  SIDEBAR_WIDTH: 300,
  SIDEBAR_MIN_WIDTH: 220,
  SIDEBAR_MAX_WIDTH: 500,
  DEFAULT_URL: 'https://duckduckgo.com',
  NEW_TAB_URL: 'astra://newtab',
  SEARCH_URL: 'https://duckduckgo.com/?q=',
  MAX_LISTENERS: 50,
  MAX_SUGGESTIONS: 6,
  HISTORY_DEBOUNCE_MS: 300,
  ZOOM_STEP: 0.1,
  ZOOM_MIN: 0.5,
  ZOOM_MAX: 3.0,
  WINDOW: {
    WIDTH: 1200,
    HEIGHT: 800,
    MIN_WIDTH: 800,
    MIN_HEIGHT: 600,
    BG_COLOR: '#1a1a4e',
    TITLE: 'Astra',
  },
} as const;
