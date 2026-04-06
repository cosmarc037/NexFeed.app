import React, { useState } from "react";
import {
  LayoutDashboard,
  BarChart3,
  Trash2,
  FlaskConical,
  Wheat,
  Settings,
  ChevronDown,
  ChevronRight,
  History,
  Database,
  CalendarDays,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export const FEEDMILL_LINES = [
  { id: "FM1", label: "Feedmill 1", lines: ["Line 1", "Line 2"], icon: Wheat },
  { id: "FM2", label: "Feedmill 2", lines: ["Line 3", "Line 4"], icon: Wheat },
  { id: "FM3", label: "Feedmill 3", lines: ["Line 6", "Line 7"], icon: Wheat },
  { id: "PMX", label: "Powermix", lines: ["Line 5"], icon: FlaskConical },
];

function NavBadge({ count, active = false }) {
  if (!count) return null;
  return (
    <span
      className={cn(
        "ml-auto min-w-[20px] h-5 px-1.5 rounded-full text-[10px] font-semibold flex items-center justify-center",
        active ? "bg-white/20 text-white" : "bg-[#fff5ed] text-[#2e343a]",
      )}
    >
      {count > 999 ? "999+" : count}
    </span>
  );
}

function NavItem({ label, active, onClick, icon: Icon, badge, badgeActive, tourClass, tourAttr }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-[12px] transition-all",
        active
          ? "bg-[#fd5108] text-white font-semibold"
          : "text-[#2e343a] font-normal hover:bg-[#fff5ed]",
        tourClass,
      )}
      data-tour={tourAttr}
    >
      {Icon && <Icon className="h-4 w-4 flex-shrink-0" />}
      <span className="text-left flex-1">{label}</span>
      {badge != null && <NavBadge count={badge} active={active} />}
    </button>
  );
}

export default function Sidebar({
  isOpen,
  activeSection,
  activeSubSection,
  activeFeedmill,
  onNavigate,
  orderCounts = {},
  onClearAll,
}) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [ordersExpanded, setOrdersExpanded] = useState(true);
  const [configExpanded, setConfigExpanded] = useState(true);

  const getFeedmillCount = (fmId) => orderCounts[`fm_active_${fmId}`] || 0;

  const isOrdersActive = activeSection === "orders";
  const isConfigActive = activeSection === "configurations";

  return (
    <aside
      className={cn(
        "sidebar fixed left-0 top-16 h-[calc(100vh-4rem)] bg-white border-r border-gray-200 transition-all duration-300 z-40 flex flex-col",
        isOpen ? "w-[200px]" : "w-0 overflow-hidden",
      )}
    >
      <nav className="flex-1 overflow-y-auto p-3 space-y-0.5">
        {/* Overview — no sub-tabs, direct navigation */}
        <NavItem
          label="Overview"
          active={activeSection === "overview"}
          onClick={() => onNavigate("overview", null)}
          icon={LayoutDashboard}
          tourClass="sidebar-item-overview"
          tourAttr="sidebar-overview"
        />

        {/* Orders — collapsible with FM sub-tabs */}
        <button
          onClick={() => setOrdersExpanded((e) => !e)}
          className={cn(
            "sidebar-item-orders w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-[12px] transition-all mt-1",
            isOrdersActive
              ? "text-[#fd5108] font-[500]"
              : "text-[#2e343a] font-normal hover:bg-[#fff5ed]",
          )}
          data-tour="sidebar-orders"
        >
          <Wheat className="h-4 w-4 flex-shrink-0" />
          <span className="text-left flex-1">Orders</span>
          {ordersExpanded ? (
            <ChevronDown className="h-3.5 w-3.5 text-[#9ca3af]" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-[#9ca3af]" />
          )}
        </button>
        {ordersExpanded && (
          <div className="feedmill-tabs pl-4 space-y-0.5" data-tour="orders-feedmill-tabs">
            {FEEDMILL_LINES.map((fm) => {
              const isFmActive =
                activeSection === "orders" && activeFeedmill === fm.id;
              return (
                <NavItem
                  key={fm.id}
                  label={fm.label}
                  active={isFmActive}
                  onClick={() => onNavigate("orders", "all", fm.id)}
                  icon={fm.icon}
                  badge={getFeedmillCount(fm.id)}
                />
              );
            })}
          </div>
        )}

        {/* Analytics — no sub-tabs, direct navigation */}
        <NavItem
          label="Analytics"
          active={activeSection === "analytics"}
          onClick={() => onNavigate("analytics", null)}
          icon={BarChart3}
          tourClass="sidebar-item-analytics"
          tourAttr="sidebar-analytics"
        />

        {/* Configurations — collapsible */}
        <button
          onClick={() => setConfigExpanded((e) => !e)}
          className={cn(
            "sidebar-item-configurations w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-[12px] transition-all mt-1",
            isConfigActive
              ? "text-[#fd5108] font-[500]"
              : "text-[#2e343a] font-normal hover:bg-[#fff5ed]",
          )}
          data-tour="sidebar-configurations"
        >
          <Settings className="h-4 w-4 flex-shrink-0" />
          <span className="text-left flex-1">Configurations</span>
          {configExpanded ? (
            <ChevronDown className="h-3.5 w-3.5 text-[#9ca3af]" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-[#9ca3af]" />
          )}
        </button>
        {configExpanded && (
          <div className="pl-4 space-y-0.5">
            <NavItem
              label="Order History"
              active={
                activeSection === "configurations" &&
                activeSubSection === "order_history"
              }
              onClick={() => onNavigate("configurations", "order_history")}
              icon={History}
              tourClass="sidebar-item-order-history"
              tourAttr="sidebar-order-history"
            />
            <NavItem
              label="Master Data"
              active={
                activeSection === "configurations" &&
                activeSubSection === "knowledge_base"
              }
              onClick={() => onNavigate("configurations", "knowledge_base")}
              icon={Database}
              tourClass="sidebar-item-master-data"
              tourAttr="sidebar-master-data"
            />
            <NavItem
              label="Next 10 Days"
              active={
                activeSection === "configurations" &&
                activeSubSection === "next_10_days"
              }
              onClick={() => onNavigate("configurations", "next_10_days")}
              icon={CalendarDays}
              tourClass="sidebar-item-n10d"
              tourAttr="sidebar-n10d"
            />
          </div>
        )}
      </nav>

      <div className="border-t border-gray-200 p-4 shrink-0">
        <button
          onClick={() => setShowConfirm(true)}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-[12px] font-normal text-gray-500 hover:text-red-600 hover:bg-red-50 transition-all"
        >
          <Trash2 className="h-4 w-4 flex-shrink-0" />
          <span>Clear All Orders</span>
        </button>
      </div>

      <AlertDialog open={showConfirm} onOpenChange={setShowConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear All Orders?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove all uploaded data across all tabs and cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isClearing}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700 text-white"
              disabled={isClearing}
              style={{ display:"inline-flex", alignItems:"center", gap:6, opacity: isClearing ? 0.85 : 1, cursor: isClearing ? "not-allowed" : "pointer" }}
              onClick={async (e) => {
                e.preventDefault();
                if (isClearing) return;
                setIsClearing(true);
                try { await onClearAll?.(); } catch {}
                setIsClearing(false);
                setShowConfirm(false);
              }}
            >
              {isClearing && (
                <svg className="loading-spinner" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.3" />
                  <path d="M12.5 7a5.5 5.5 0 01-5.5 5.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              )}
              {isClearing ? "Clearing…" : "Clear All Orders"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  );
}
