import { BaseWindow, WebContentsView } from 'electron';
import { CONFIG } from '../types';

/**
 * CompactModeManager - Zen-exact sidebar auto-hide.
 *
 * CORE PRINCIPLE (from Zen):
 *   In compact mode, content is ALWAYS full width.
 *   Sidebar ALWAYS floats on top as an overlay.
 *   Toggle just shows/hides the floating sidebar.
 *   Content NEVER moves. Zero snapping.
 *
 * States:
 *   'expanded' - normal mode, sidebar takes layout space
 *   'hidden'   - compact mode, sidebar floats (overlay)
 *
 * enterCompactMode(): expanded → hidden (one-time setup)
 * exitCompactMode():  hidden → expanded (restore layout)
 * toggleMode():       show/hide the floating sidebar
 */

export type CompactMode = 'expanded' | 'hidden';

const BG_COLOR = CONFIG.WINDOW.BG_COLOR;
const TRANSPARENT = '#00000000';
const EDGE_WIDTH = 12;
const HIDE_DELAY_MS = 300;
const ANIM_MS = 250;
const COOLDOWN_MS = 400;
const GRACE_MS = 500;

export class CompactModeManager {
  private mode: CompactMode = 'expanded';
  private overlayVisible = false;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private animTimer: ReturnType<typeof setTimeout> | null = null;
  private cooldownUntil = 0;
  private showTimestamp = 0;
  private baseWidth = 300;

  constructor(
    private readonly mainWindow: BaseWindow,
    private readonly sidebarView: WebContentsView,
    private readonly layoutCallback: (sidebarWidth: number) => void,
  ) {}

  getMode(): CompactMode { return this.mode; }
  isSidebarVisible(): boolean { return this.mode === 'expanded' || this.overlayVisible; }
  getSidebarWidth(): number {
    if (this.mode === 'expanded') return this.baseWidth;
    return this.overlayVisible ? this.baseWidth : 0;
  }
  setBaseWidth(w: number): void { this.baseWidth = w; }
  getBaseWidth(): number { return this.baseWidth; }
  setResizing(_r: boolean): void {
    void _r;
  }

  // ==== Toggle ====

  toggleMode(): void {
    this.clearAll();

    if (this.mode === 'expanded') {
      // Enter compact mode: content goes full width, sidebar becomes overlay
      this.mode = 'hidden';
      this.overlayVisible = false;

      // Content goes full width ONCE (this is entering compact mode)
      this.layoutCallback(0);

      // Sidebar slides out via CSS
      this.sidebarView.setBackgroundColor(TRANSPARENT);
      this.sidebarToFront();
      this.sendState('hiding');

      this.animTimer = setTimeout(() => {
        this.animTimer = null;
        this.shrinkToEdge();
        this.cooldownUntil = Date.now() + COOLDOWN_MS;
        this.sendState();
        console.log('[Astra] sidebar: compact mode on');
      }, ANIM_MS);

    } else if (this.overlayVisible) {
      // Already in compact mode, sidebar showing → hide it
      this.overlayVisible = false;
      this.sendState('hiding');

      this.animTimer = setTimeout(() => {
        this.animTimer = null;
        this.shrinkToEdge();
        this.cooldownUntil = Date.now() + COOLDOWN_MS;
        this.sendState();
        console.log('[Astra] sidebar: hidden');
      }, ANIM_MS);

    } else {
      // Compact mode, sidebar hidden → exit compact mode, restore layout
      this.mode = 'expanded';
      this.overlayVisible = false;
      this.sidebarView.setBackgroundColor(TRANSPARENT);
      this.setSidebarFull();
      this.sidebarToFront();

      // CSS slideIn first, content stays at x=0 during animation
      this.sendState('showing');

      this.animTimer = setTimeout(() => {
        this.animTimer = null;
        // NOW move content (after sidebar is fully visible)
        this.sidebarToBack();
        this.layoutCallback(this.baseWidth);
        this.sidebarView.setBackgroundColor(BG_COLOR);
        this.sendState();
        console.log('[Astra] sidebar: compact mode off');
      }, ANIM_MS);
    }
  }

  setMode(m: CompactMode | 'full' | string): void {
    this.clearAll();
    if (m === 'expanded' || m === 'full') {
      this.mode = 'expanded';
      this.overlayVisible = false;
      this.sidebarView.setBackgroundColor(BG_COLOR);
      this.setSidebarFull();
      this.sidebarToBack();
      this.layoutCallback(this.baseWidth);
    } else {
      this.mode = 'hidden';
      this.overlayVisible = false;
      this.sidebarView.setBackgroundColor(TRANSPARENT);
      this.shrinkToEdge();
      this.sidebarToFront();
      this.layoutCallback(0);
    }
    this.sendState();
  }

  // ==== Overlay (hover) ====

  onEdgeEnter(): void {
    if (this.mode === 'expanded') return;
    if (this.overlayVisible) { this.clearHideTimer(); return; }
    if (this.animTimer) return;
    if (Date.now() < this.cooldownUntil) return;

    this.clearHideTimer();
    this.overlayVisible = true;
    this.showTimestamp = Date.now();

    // Show sidebar as overlay (content stays at x=0)
    this.setSidebarFull();
    this.sidebarToFront();
    this.sendState('showing');

    this.animTimer = setTimeout(() => {
      this.animTimer = null;
      this.sendState();
    }, ANIM_MS);

    console.log('[Astra] sidebar: overlay shown');
  }

  onEdgeLeave(): void {
    if (this.mode === 'expanded' || !this.overlayVisible) return;
    if (Date.now() - this.showTimestamp < GRACE_MS) return;
    this.startHideTimer();
  }

  onEdgeCancelHide(): void { this.clearHideTimer(); }
  handleMouseMove(): void {
    return;
  }
  flashSidebar(): void {
    return;
  }
  lockForPopup(): void {
    return;
  }
  unlockFromPopup(): void {
    return;
  }

  // ==== View helpers ====

  private setSidebarFull(): void {
    const { height } = this.mainWindow.getContentBounds();
    this.sidebarView.setBounds({ x: 0, y: 0, width: this.baseWidth + 8, height });
  }

  private shrinkToEdge(): void {
    const { height } = this.mainWindow.getContentBounds();
    this.sidebarView.setBounds({ x: 0, y: 0, width: EDGE_WIDTH, height });
  }

  private sidebarToFront(): void {
    try {
      const p = this.mainWindow.contentView;
      p.removeChildView(this.sidebarView);
      p.addChildView(this.sidebarView);
    } catch {
      /* view may already be detached during window teardown */
    }
  }

  private sidebarToBack(): void {
    try {
      const p = this.mainWindow.contentView;
      p.removeChildView(this.sidebarView);
      p.addChildView(this.sidebarView, 0);
    } catch {
      /* view may already be detached during window teardown */
    }
  }

  // ==== Timers ====

  private startHideTimer(): void {
    this.clearHideTimer();
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      if (!this.overlayVisible) return;

      this.sendState('hiding');

      this.animTimer = setTimeout(() => {
        this.animTimer = null;
        this.overlayVisible = false;
        this.shrinkToEdge();
        this.cooldownUntil = Date.now() + COOLDOWN_MS;
        this.sendState();
        console.log('[Astra] sidebar: overlay hidden');
      }, ANIM_MS);
    }, HIDE_DELAY_MS);
  }

  private clearHideTimer(): void {
    if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null; }
  }

  private clearAll(): void {
    this.clearHideTimer();
    if (this.animTimer) { clearTimeout(this.animTimer); this.animTimer = null; }
  }

  // ==== IPC ====

  private sendState(animating?: 'hiding' | 'showing'): void {
    this.sidebarView.webContents.send('compact:state', {
      mode: this.mode,
      expanded: this.mode === 'expanded',
      sidebarVisible: this.isSidebarVisible(),
      sidebarWidth: this.getSidebarWidth(),
      animating: animating || null,
    });
  }
}
