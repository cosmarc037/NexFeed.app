import React from 'react';
import { Search, Filter, X } from 'lucide-react';
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";

export default function SearchFilter({ 
  searchTerm, 
  onSearchChange, 
  filters, 
  onFilterChange,
  onClearFilters,
  bulkModeSlot
}) {
  const activeFilterCount = Object.values(filters).filter(v => v && v !== 'all').length;

  return (
    <div className="flex flex-col sm:flex-row gap-3">
      <div className="relative flex-1 max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
        <Input
          type="text"
          placeholder="Search by item, material code, FPR..."
          value={searchTerm}
          onChange={(e) => onSearchChange(e.target.value)}
          className="pl-10 h-10 bg-white border-gray-200 text-[12px] md:text-[12px]"
        />
        {searchTerm && (
          <button 
            onClick={() => onSearchChange('')}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" className="h-10 gap-2 text-[12px]">
            <Filter className="h-4 w-4" />
            Filters
            {activeFilterCount > 0 && (
              <Badge className="bg-[#fd5108] text-white h-5 w-5 p-0 flex items-center justify-center text-xs">
                {activeFilterCount}
              </Badge>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80" align="end">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h4 className="font-medium text-[12px]">Filters</h4>
              {activeFilterCount > 0 && (
                <Button 
                  variant="ghost" 
                  size="sm" 
                  onClick={onClearFilters}
                  className="text-xs text-[#fd5108] h-7"
                >
                  Clear all
                </Button>
              )}
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-[12px] font-medium text-gray-600 mb-1.5 block">
                  Form
                </label>
                <Select 
                  value={filters.form || 'all'} 
                  onValueChange={(val) => onFilterChange('form', val)}
                >
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="All Forms" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Forms</SelectItem>
                    <SelectItem value="MP">MP</SelectItem>
                    <SelectItem value="P">P</SelectItem>
                    <SelectItem value="C">C</SelectItem>
                    <SelectItem value="M">M</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <label className="text-[12px] font-medium text-gray-600 mb-1.5 block">
                  Status
                </label>
                <Select
                  value={filters.status || 'all'}
                  onValueChange={(val) => onFilterChange('status', val)}
                >
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="All Statuses" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Statuses</SelectItem>
                    <SelectItem value="plotted">Plotted</SelectItem>
                    <SelectItem value="hold">Hold</SelectItem>
                    <SelectItem value="cut">Cut</SelectItem>
                    <SelectItem value="combined">Combine with other PO</SelectItem>
                    <SelectItem value="cancel_po">Cancel PO</SelectItem>
                    <SelectItem value="in_production">In production</SelectItem>
                    <SelectItem value="ongoing_batching">On-going batching</SelectItem>
                    <SelectItem value="ongoing_pelleting">On-going pelleting</SelectItem>
                    <SelectItem value="ongoing_bagging">On-going bagging</SelectItem>
                    <SelectItem value="completed">Done</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <label className="text-[12px] font-medium text-gray-600 mb-1.5 block">
                  Readiness Status
                </label>
                <Select 
                  value={filters.readiness || 'all'} 
                  onValueChange={(val) => onFilterChange('readiness', val)}
                >
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="All" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="ready">Ready (OK)</SelectItem>
                    <SelectItem value="not_ready">Needs Fixing</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        </PopoverContent>
      </Popover>

      {bulkModeSlot}
    </div>
  );
}