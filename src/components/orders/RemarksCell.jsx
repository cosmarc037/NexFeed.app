import React, { useState, useRef, useLayoutEffect, useEffect } from 'react';
import { cn } from "@/lib/utils";

export default function RemarksCell({ value, onSave, readOnly = false, placeholder = '-', className = '', cancelNote = null }) {
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [editValue, setEditValue] = useState(value || '');
  const [isTruncated, setIsTruncated] = useState(false);
  const textRef = useRef(null);
  const textareaRef = useRef(null);

  const display = value || '';
  const hasCancelNote = cancelNote && cancelNote.trim().length > 0;
  const hasContent = !!(display || hasCancelNote);

  useLayoutEffect(() => {
    if (textRef.current) {
      setIsTruncated(textRef.current.scrollHeight > textRef.current.clientHeight + 1);
    }
  }, [value, cancelNote]);

  useEffect(() => {
    if (!editing) setEditValue(value || '');
  }, [value, editing]);

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus();
      const len = textareaRef.current.value.length;
      textareaRef.current.setSelectionRange(len, len);
    }
  }, [editing]);

  const handleCellClick = () => {
    if (readOnly) {
      if (hasContent) setExpanded(true);
    } else {
      setEditValue(value || '');
      setEditing(true);
    }
  };

  const handleExpandClick = (e) => {
    e.stopPropagation();
    setExpanded(true);
  };

  const handleSave = () => {
    if (onSave) onSave(editValue);
    setEditing(false);
  };

  const handleCancel = () => {
    setEditValue(value || '');
    setEditing(false);
  };

  const handleEditFromPopup = () => {
    setExpanded(false);
    setEditValue(value || '');
    setEditing(true);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') handleCancel();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleSave();
  };

  if (editing) {
    return (
      <div className={cn("relative", className)} data-no-drag="true">
        <textarea
          ref={textareaRef}
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={handleKeyDown}
          className="w-full text-[13px] text-[#374151] border border-[#fd5108] rounded p-2 resize-y focus:outline-none leading-relaxed"
          style={{ minHeight: 60, maxHeight: 150 }}
          data-no-drag="true"
        />
        <div className="flex justify-end gap-2 mt-1">
          <button
            onClick={handleCancel}
            style={{ fontSize: 11, color: '#6b7280', background: 'none', border: '1px solid #d1d5db', borderRadius: 3, padding: '1px 8px', cursor: 'pointer' }}
            data-no-drag="true"
          >Cancel</button>
          <button
            onClick={handleSave}
            style={{ fontSize: 11, color: '#fff', background: '#fd5108', border: 'none', borderRadius: 3, padding: '2px 10px', cursor: 'pointer', fontWeight: 600 }}
            data-no-drag="true"
          >Save</button>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("relative", className)}>
      <div
        ref={textRef}
        onClick={handleCellClick}
        className={cn(
          "text-[13px] transition-colors",
          (hasContent || !readOnly) ? "cursor-pointer hover:text-gray-900" : "cursor-default"
        )}
        style={{
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          paddingRight: isTruncated ? 18 : 0,
        }}
        title={!readOnly ? "Click to edit" : hasContent ? "Click to expand" : undefined}
      >
        {hasContent ? (
          <>
            {display && <span className="text-gray-600">{display}</span>}
            {display && hasCancelNote && <br />}
            {hasCancelNote && <span className="text-[#e53935]">{cancelNote}</span>}
          </>
        ) : (
          <span className="text-[12px] italic text-gray-300">{placeholder}</span>
        )}
      </div>

      {hasContent && isTruncated && (
        <button
          onClick={handleExpandClick}
          className="absolute top-0 right-0 text-[#9ca3af] hover:text-[#fd5108] transition-colors leading-none"
          style={{ fontSize: 12, background: 'none', border: 'none', padding: '1px 2px', cursor: 'pointer' }}
          title="View full text"
          data-no-drag="true"
        >⤢</button>
      )}

      {expanded && hasContent && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setExpanded(false)} />
          <div
            className="absolute z-50 left-0 top-6 bg-white rounded-lg border border-gray-200 p-3"
            style={{ width: 360, maxHeight: 300, boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ maxHeight: 220, overflowY: 'auto' }}>
              {display && <p className="text-[13px] text-[#374151] whitespace-pre-wrap leading-relaxed">{display}</p>}
              {hasCancelNote && (
                <div className={cn("p-2 bg-red-50 border border-red-100 rounded", display && "mt-2")}>
                  <p className="text-[10px] font-medium text-gray-400 mb-1">System Note (read-only)</p>
                  <p className="text-xs text-[#e53935] whitespace-pre-wrap">{cancelNote}</p>
                </div>
              )}
            </div>
            <div className="flex justify-end gap-3 mt-2">
              {!readOnly && (
                <button
                  onClick={handleEditFromPopup}
                  style={{ fontSize: 11, color: '#fd5108', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}
                  className="hover:underline"
                >Edit</button>
              )}
              <button
                onClick={() => setExpanded(false)}
                style={{ fontSize: 11, color: '#6b7280', background: 'none', border: 'none', cursor: 'pointer' }}
                className="hover:text-[#fd5108]"
              >Close</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
