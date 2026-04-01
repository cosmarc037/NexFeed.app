import React from "react";
import { Menu, HelpCircle, User, Settings, LogOut } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

export default function Header({ onToggleSidebar, userName = "User" }) {
  return (
    <header className="h-16 bg-white border-b border-gray-200 flex items-center justify-between px-4 fixed top-0 left-0 right-0 z-50">
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
            NexFeed: Production Schedule
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="text-gray-600 hover:text-[#fd5108]"
        >
          <HelpCircle className="h-4 w-4 mr-1" />
          Help
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="rounded-full bg-gray-100 hover:bg-orange-50"
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
