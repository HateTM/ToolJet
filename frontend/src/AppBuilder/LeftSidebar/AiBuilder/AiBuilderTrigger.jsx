import React from 'react';
import { Sparkles } from 'lucide-react';
import { SidebarItem } from '../SidebarItem/SidebarItem';

// Matches BaseLeftSidebar's `renderAISideBarTrigger({ darkMode, setSideBarBtnRefs, selectedSidebarItem, handleSelectedSidebarItem })`
// contract — clicking it opens the 'tooljetai' popover (see LeftSidebar.jsx's renderPopoverContent switch).
export const AiBuilderTrigger = ({ darkMode, setSideBarBtnRefs, selectedSidebarItem, handleSelectedSidebarItem }) => (
  <SidebarItem
    selectedSidebarItem={selectedSidebarItem}
    onClick={() => handleSelectedSidebarItem('tooljetai')}
    darkMode={darkMode}
    icon="tooljetai"
    className="left-sidebar-item left-sidebar-layout"
    tip="AI Builder"
    ref={setSideBarBtnRefs('tooljetai')}
    data-cy="left-sidebar-ai-builder-button"
  >
    <Sparkles width="16" height="16" className="tw-text-icon-strong" />
  </SidebarItem>
);

export default AiBuilderTrigger;
