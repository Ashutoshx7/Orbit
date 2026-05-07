import React, { useState } from 'react';
import type { SpaceData, Tab } from '../types/renderer';

interface SpacesPanelProps {
  spaces: SpaceData[];
  tabs: Tab[];
  activeSpaceId: string;
  onSwitchSpace: (id: string) => void;
  onCreateSpace: () => void;
}

const SpacesPanel: React.FC<SpacesPanelProps> = ({
  spaces, tabs, activeSpaceId, onSwitchSpace, onCreateSpace,
}) => {
  const [editingSpaceId, setEditingSpaceId] = useState<string | null>(null);
  const [editingSpaceName, setEditingSpaceName] = useState('');

  return (
    <div className="spaces-panel">
      <div className="panel-header">
        <h3>Workspaces</h3>
        <button className="space-create-btn" onClick={onCreateSpace} title="Create workspace">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19"/>
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
        </button>
      </div>

      <div className="spaces-list">
        {spaces.map((space) => (
          <div
            key={space.id}
            className={`space-card ${space.id === activeSpaceId ? 'active' : ''}`}
            style={{ '--space-color': space.color || '#4f52ff' } as React.CSSProperties}
            onClick={() => onSwitchSpace(space.id)}
          >
            <div
              className="space-card-indicator"
              style={{ background: space.color || '#6366f1' }}
            />
            <span className="space-card-icon">{space.icon}</span>
            <div className="space-card-info">
              {editingSpaceId === space.id ? (
                <input
                  className="space-rename-input"
                  value={editingSpaceName}
                  onChange={(e) => setEditingSpaceName(e.target.value)}
                  onBlur={() => {
                    if (editingSpaceName.trim())
                      window.astra.renameSpace(space.id, editingSpaceName.trim());
                    setEditingSpaceId(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                    if (e.key === 'Escape') setEditingSpaceId(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  autoFocus
                  spellCheck={false}
                />
              ) : (
                <span className="space-card-name">{space.name}</span>
              )}
              <span className="space-card-tabs">
                {tabs.filter((t) => t.spaceId === space.id).length} tabs
              </span>
            </div>
            <div className="space-card-actions" onClick={(e) => e.stopPropagation()}>
              <button
                className="space-card-action"
                onClick={() => {
                  setEditingSpaceId(space.id);
                  setEditingSpaceName(space.name);
                }}
                title="Rename"
              >
                ✏️
              </button>
              {spaces.length > 1 && (
                <button
                  className="space-card-action danger"
                  onClick={() => {
                    if (confirm('Delete this workspace?'))
                      window.astra.deleteSpace(space.id);
                  }}
                  title="Delete"
                >
                  🗑️
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default SpacesPanel;
