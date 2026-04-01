import React from 'react';
import { cn } from "@/lib/utils";

const feedmillTabs = [
  { id: 'all', label: 'All Lines' },
  { id: 'FM1', label: 'FM1', lines: ['Line 1', 'Line 2'] },
  { id: 'FM2', label: 'FM2', lines: ['Line 3', 'Line 4'] },
  { id: 'FM3', label: 'FM3', lines: ['Line 6', 'Line 7'] },
  { id: 'PMX', label: 'PMX', lines: ['Line 5'] },
];

export default function FeedmillTabs({ activeTab, onTabChange }) {
  return (
    <div className="flex gap-1 p-1">
      {feedmillTabs.map(tab => (
        <button
          key={tab.id}
          onClick={() => onTabChange(tab.id)}
          className={cn(
            "px-4 py-1.5 rounded-lg text-sm font-medium transition-all",
            activeTab === tab.id
              ? "bg-[#fd5108] text-white"
              : "text-[#2e343a] hover:bg-[#fff5ed]"
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export { feedmillTabs };