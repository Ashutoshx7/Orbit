import React from 'react';
import type { SpaceData, PanelMode } from '../types/renderer';

interface BottomBarProps {
  spaces: SpaceData[];
  activeSpaceId: string;
  panelMode: PanelMode;
  onOpenSettings: () => void;
  onSwitchSpace: (id: string) => void;
  onSpaceContextMenu: (e: React.MouseEvent, spaceId: string) => void;
  onCreateSpace: () => void;
}

const BottomBar: React.FC<BottomBarProps> = ({
  spaces, activeSpaceId, panelMode,
  onOpenSettings, onSwitchSpace, onSpaceContextMenu, onCreateSpace,
}) => (
  <div className="sidebar-bottom-bar">
    {/* Settings */}
    <button
      className={`bottom-bar-settings ${panelMode === 'settings' ? 'active' : ''}`}
      onClick={onOpenSettings}
      title="Settings"
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="8" cy="8" r="2"/>
        <path d="M8 1.5v1.3M8 13.2v1.3M3.4 3.4l.9.9M11.7 11.7l.9.9M1.5 8h1.3M13.2 8h1.3M3.4 12.6l.9-.9M11.7 4.3l.9-.9"/>
      </svg>
    </button>

    {/* Space icons */}
    <div className="bottom-bar-spaces">
      {spaces.map((space) => (
        <div
          key={space.id}
          className={`space-icon ${space.id === activeSpaceId ? 'active' : ''}`}
          style={{ '--space-color': space.color || '#4f52ff' } as React.CSSProperties}
          onClick={() => onSwitchSpace(space.id)}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onSpaceContextMenu(e, space.id); }}
          title={space.name}
        >
          {space.icon}
        </div>
      ))}
    </div>

    {/* New workspace */}
    <button
      className="bottom-bar-add"
      onClick={onCreateSpace}
      title="New Workspace"
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <line x1="8" y1="3" x2="8" y2="13"/>
        <line x1="3" y1="8" x2="13" y2="8"/>
      </svg>
    </button>
  </div>
);

export default BottomBar;
