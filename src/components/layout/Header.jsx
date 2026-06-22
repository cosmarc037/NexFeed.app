import React, { useState, useEffect } from "react";
import {
  Menu,
  HelpCircle,
  User,
  Settings,
  LogOut,
  Compass,
  Palette,
  Moon,
  Sun,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";

const THEMES = [
  { key: "default",  name: "Default (NexFeed)",  primary: "#fd5108", dark: "#e04600" },
  { key: "pilmico",  name: "Pilmico",             primary: "#0099DD", dark: "#007ab8" },
  { key: "aboitiz",  name: "Aboitiz Foods",       primary: "#4CAF50", dark: "#388E3C" },
];

function hexToRgbComponents(hex) {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `${r}, ${g}, ${b}`;
}

function applyTheme(primary, dark) {
  document.documentElement.style.setProperty("--nexfeed-primary", primary);
  document.documentElement.style.setProperty("--nexfeed-primary-dark", dark);
  document.documentElement.style.setProperty("--nexfeed-primary-rgb", hexToRgbComponents(primary));
  window.dispatchEvent(new CustomEvent("nexfeed-theme-change", { detail: { primary, dark } }));
}

function ThemeSwitcher() {
  const [theme, setTheme] = useState(() => localStorage.getItem("nexfeed-theme") || "default");
  const [dark, setDark] = useState(() => localStorage.getItem("nexfeed-dark") === "1");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const t = THEMES.find(t => t.key === theme) || THEMES[0];
    applyTheme(t.primary, t.dark);
  }, [theme]);

  useEffect(() => {
    const html = document.documentElement;
    if (dark) {
      html.classList.add("nexfeed-dark");
      html.classList.add("dark");
      html.style.colorScheme = "dark";
    } else {
      html.classList.remove("nexfeed-dark");
      html.classList.remove("dark");
      html.style.colorScheme = "light";
    }
  }, [dark]);

  function selectTheme(key) {
    setTheme(key);
    localStorage.setItem("nexfeed-theme", key);
  }

  function toggleDark() {
    const next = !dark;
    setDark(next);
    localStorage.setItem("nexfeed-dark", next ? "1" : "");
  }

  const activeTheme = THEMES.find(t => t.key === theme) || THEMES[0];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="text-gray-600 hover:text-[var(--nexfeed-primary)]"
          title="Appearance"
          data-testid="button-theme-switcher"
        >
          <Palette className="h-4 w-4 mr-1" />
          Themes
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-52 p-3 space-y-3">
        {/* Dark mode */}
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Dark Mode</span>
          <button
            onClick={toggleDark}
            className={`relative w-9 h-5 rounded-full transition-colors ${dark ? "bg-[var(--nexfeed-primary)]" : "bg-gray-300"}`}
            data-testid="button-toggle-dark-mode"
            title={dark ? "Switch to light mode" : "Switch to dark mode"}
          >
            <span
              className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all ${dark ? "left-4" : "left-0.5"}`}
            />
          </button>
        </div>

        <div className="h-px bg-gray-200" />

        {/* Theme circles */}
        <div>
          <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Theme</span>
          <div className="flex gap-2 mt-2">
            {THEMES.map(t => (
              <button
                key={t.key}
                onClick={() => selectTheme(t.key)}
                title={t.name}
                data-testid={`button-theme-${t.key}`}
                style={{ background: t.primary }}
                className={`w-7 h-7 rounded-full transition-all hover:scale-110 ${
                  theme === t.key
                    ? "ring-2 ring-offset-2 ring-gray-800 scale-110"
                    : ""
                }`}
              />
            ))}
          </div>
          <p className="text-[10px] text-gray-400 mt-1.5">{activeTheme.name}</p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export default function Header({
  onToggleSidebar,
  userName = "User",
  onStartTour,
}) {
  return (
    <header className="nexfeed-header h-16 bg-white border-b border-gray-200 flex items-center justify-between px-4 fixed top-0 left-0 right-0 z-50">
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggleSidebar}
          className="hover:bg-orange-50"
        >
          <Menu className="h-5 w-5 text-gray-700" />
        </Button>

        <div className="flex items-center gap-3">
          <span className="text-[14px] font-medium text-gray-800 tracking-tight">
            NexFeed: Smart Production Schedule
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="text-gray-600 hover:text-[var(--nexfeed-primary)]"
          onClick={onStartTour}
          data-testid="button-take-tour"
          data-tour="header-take-tour"
        >
          <Compass className="h-4 w-4 mr-1" />
          Take a tour
        </Button>

        <Button
          variant="ghost"
          size="sm"
          className="text-gray-600 hover:text-[var(--nexfeed-primary)]"
          data-tour="header-help"
        >
          <HelpCircle className="h-4 w-4 mr-1" />
          Help
        </Button>

        <ThemeSwitcher />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="rounded-full bg-gray-100 hover:bg-orange-50"
              data-tour="header-user"
            >
              <User className="h-5 w-5 text-gray-600" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <div className="px-3 py-2">
              <p className="text-sm font-medium text-gray-900">{userName}</p>
              <p className="text-xs text-gray-500">Production Manager</p>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="cursor-pointer">
              <Settings className="h-4 w-4 mr-2" />
              Settings
            </DropdownMenuItem>
            <DropdownMenuItem className="cursor-pointer text-red-600">
              <LogOut className="h-4 w-4 mr-2" />
              Logout
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
