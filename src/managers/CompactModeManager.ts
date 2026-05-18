import { BaseWindow, WebContentsView } from 'electron';
import { CONFIG } from '../types';

/**
 * CompactModeManager - Zen-exact sidebar auto-hide.
 *
 * CORE PRINCIPLE (from Zen):
 *   In compact hover mode, content stays full width.
 *   Sidebar floats on top as an overlay.
 *   The explicit toggle docks/undocks the sidebar, so content animates with it.
 *
 * States:
 *   'expanded' - normal mode, sidebar takes layout space
 *   'hidden'   - compact mode, sidebar floats (overlay)
 *
 * enterCompactMode(): expanded → hidden (content becomes full width)
 * setMode('expanded'): hidden → expanded (restore layout)
 * toggleMode():       dock/undock the sidebar
 */

export type CompactMode = 'expanded' | 'hidden';

const BG_COLOR = CONFIG.WINDOW.BG_COLOR;
const TRANSPARENT = '#00000000';
const EDGE_WIDTH = 10;
const ANIM_MS = 120;
const HOVER_KEEP_MS = 150;
const WINDOW_EDGE_KEEP_MS = 1000;
const HOVER_RECHECK_MS = 0;
const TOGGLE_IGNORE_HOVER_MS = 180;

type SidebarAnimation = 'hiding' | 'showing';
type LayoutEasing = 'easeIn' | 'easeOut';
type PointerPosition = { x: number; y: number };

export class CompactModeManager {
  private mode: CompactMode = 'expanded';
  private overlayVisible = false;
  private userShow = false;
  private edgeHovered = false;
  private popupLocked = false;
  private resizing = false;
  private animating: SidebarAnimation | null = null;
  private ignoreHoverUntil = 0;
  private showTimer: ReturnType<typeof setTimeout> | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private animTimer: ReturnType<typeof setTimeout> | null = null;
  private baseWidth = 300;
  private lastBoundsKey = '';

  constructor(
    private readonly mainWindow: BaseWindow,
    private readonly sidebarView: WebContentsView,
    private readonly layoutCallback: (sidebarWidth: number) => void,
    private readonly animateLayoutCallback?: (
      sidebarWidth: number,
      durationMs: number,
      easing: LayoutEasing,
    ) => void,
  ) {}

  getMode(): CompactMode { return this.mode; }
  isSidebarVisible(): boolean { return this.mode === 'expanded' || this.overlayVisible; }
  getSidebarWidth(): number {
    if (this.mode === 'expanded') return this.baseWidth;
    return this.overlayVisible ? this.baseWidth : 0;
  }
  setBaseWidth(w: number): void { this.baseWidth = w; }
  getBaseWidth(): number { return this.baseWidth; }
  setResizing(r: boolean): void {
    this.resizing = r;
    if (r) {
      this.clearHideTimer();
    } else if (this.overlayVisible && !this.edgeHovered) {
      this.queueHide();
    }
  }

  // ==== Toggle ====

  toggleMode(): void {
    if (this.mode === 'expanded') {
      this.enterCompactMode();
      return;
    }

    this.exitCompactMode();
  }

  setMode(m: CompactMode | 'full' | string): void {
    this.clearAll();
    this.edgeHovered = false;
    this.userShow = false;
    this.ignoreHoverUntil = 0;
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
    this.edgeHovered = true;
    this.clearHideTimer();

    if (Date.now() < this.ignoreHoverUntil) return;
    if (this.overlayVisible && this.animating !== 'hiding') return;

    this.startShowTimer(HOVER_RECHECK_MS);
  }

  onEdgeLeave(position?: PointerPosition): void {
    if (this.mode === 'expanded') return;
    this.edgeHovered = false;
    this.clearShowTimer();
    if (!this.overlayVisible) return;
    this.queueHide(this.isLeavingThroughWindowEdge(position) ? WINDOW_EDGE_KEEP_MS : HOVER_KEEP_MS);
  }

  onEdgeCancelHide(): void { this.clearHideTimer(); }
  handleMouseMove(_x: number, _y: number): void {
    void _x;
    void _y;
  }
  flashSidebar(): void {
    return;
  }
  lockForPopup(): void {
    this.popupLocked = true;
    this.clearHideTimer();
  }
  unlockFromPopup(): void {
    this.popupLocked = false;
    if (this.overlayVisible && !this.edgeHovered) this.queueHide();
  }

  // ==== View helpers ====

  private setSidebarFull(): void {
    this.setBounds(this.baseWidth + 8);
  }

  private shrinkToEdge(): void {
    this.setBounds(EDGE_WIDTH);
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

  private enterCompactMode(): void {
    this.clearAll();
    this.edgeHovered = false;
    this.userShow = false;
    this.mode = 'hidden';
    this.overlayVisible = false;
    this.ignoreHoverUntil = Date.now() + TOGGLE_IGNORE_HOVER_MS;

    this.sidebarView.setBackgroundColor(TRANSPARENT);
    this.setSidebarFull();
    this.sidebarToFront();

    this.startAnimation('hiding', () => {
      this.shrinkToEdge();
      this.sendState();
    });
    this.animateLayout(0, 'easeIn');
  }

  private exitCompactMode(): void {
    const sidebarAlreadyVisible = this.overlayVisible || this.animating === 'showing';

    this.clearAll();
    this.edgeHovered = false;
    this.userShow = false;
    this.mode = 'expanded';
    this.overlayVisible = false;
    this.ignoreHoverUntil = 0;

    this.sidebarView.setBackgroundColor(sidebarAlreadyVisible ? BG_COLOR : TRANSPARENT);
    this.setSidebarFull();
    this.sidebarToFront();

    if (sidebarAlreadyVisible) {
      this.startLayoutOnlyAnimation(() => {
        this.sidebarToBack();
        this.sendState();
      });
    } else {
      this.startAnimation('showing', () => {
        this.sidebarToBack();
        this.sidebarView.setBackgroundColor(BG_COLOR);
        this.sendState();
      });
    }
    this.animateLayout(this.baseWidth, 'easeOut');
  }

  private showOverlay(userShow = false): void {
    if (this.mode === 'expanded') return;

    this.clearShowTimer();
    this.clearHideTimer();
    this.overlayVisible = true;
    this.userShow = userShow;

    // Show sidebar as overlay (content stays at x=0)
    this.setSidebarFull();
    this.sidebarToFront();
    this.startAnimation('showing', () => this.sendState());
  }

  private hideOverlay(fromToggle = false): void {
    this.clearShowTimer();
    this.clearHideTimer();
    this.userShow = false;
    this.edgeHovered = false;
    this.overlayVisible = false;
    if (fromToggle) this.ignoreHoverUntil = Date.now() + TOGGLE_IGNORE_HOVER_MS;

    this.startAnimation('hiding', () => {
      this.shrinkToEdge();
      this.sendState();
    });
  }

  private queueHide(delay = HOVER_KEEP_MS): void {
    if (!this.canAutoHide()) return;
    this.startHideTimer(delay);
  }

  private canAutoHide(): boolean {
    return (
      this.mode === 'hidden' &&
      this.overlayVisible &&
      !this.userShow &&
      !this.edgeHovered &&
      !this.popupLocked &&
      !this.resizing
    );
  }

  private startShowTimer(delay: number): void {
    this.clearShowTimer();
    this.showTimer = setTimeout(() => {
      this.showTimer = null;
      if (
        this.edgeHovered &&
        this.mode === 'hidden' &&
        !this.overlayVisible &&
        Date.now() >= this.ignoreHoverUntil
      ) {
        this.showOverlay(false);
      }
    }, delay);
  }

  private startHideTimer(delay: number): void {
    this.clearHideTimer();
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      if (!this.canAutoHide()) return;

      this.hideOverlay(false);
    }, delay);
  }

  private startAnimation(animating: SidebarAnimation, onDone: () => void): void {
    this.clearAnimationTimer();
    this.animating = animating;
    this.sendState(animating);
    this.animTimer = setTimeout(() => {
      this.animTimer = null;
      this.animating = null;
      onDone();
    }, ANIM_MS);
  }

  private startLayoutOnlyAnimation(onDone: () => void): void {
    this.clearAnimationTimer();
    this.animating = null;
    this.sendState();
    this.animTimer = setTimeout(() => {
      this.animTimer = null;
      onDone();
    }, ANIM_MS);
  }

  private clearShowTimer(): void {
    if (this.showTimer) { clearTimeout(this.showTimer); this.showTimer = null; }
  }

  private clearHideTimer(): void {
    if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null; }
  }

  private clearAnimationTimer(): void {
    if (this.animTimer) { clearTimeout(this.animTimer); this.animTimer = null; }
    this.animating = null;
  }

  private clearAll(): void {
    this.clearHideTimer();
    this.clearShowTimer();
    this.clearAnimationTimer();
  }

  private animateLayout(sidebarWidth: number, easing: LayoutEasing): void {
    if (this.animateLayoutCallback) {
      this.animateLayoutCallback(sidebarWidth, ANIM_MS, easing);
      return;
    }

    this.layoutCallback(sidebarWidth);
  }

  private setBounds(width: number): void {
    const { height } = this.mainWindow.getContentBounds();
    const boundsKey = `0:0:${width}:${height}`;
    if (boundsKey === this.lastBoundsKey) return;
    this.lastBoundsKey = boundsKey;
    this.sidebarView.setBounds({ x: 0, y: 0, width, height });
  }

  private isLeavingThroughWindowEdge(position?: PointerPosition): boolean {
    if (!position) return false;
    return position.x <= EDGE_WIDTH;
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
