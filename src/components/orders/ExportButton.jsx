import React from 'react';
import { Download } from 'lucide-react';
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { fmtVolume, fmtBatches, fmtBags, fmtHours, fmtChangeover, fmtRunRate, formatTime12 } from '../utils/formatters';

export default function ExportButton({ orders, feedmillTab, orderCategory }) {
  const generateFileName = (format) => {
    const tabName = feedmillTab || 'All';
    let cat = orderCategory || 'All';
    if (cat === 'all_planned') cat = 'All';
    else if (cat === 'cut') cat = 'Pending';
    else if (cat === 'in_production') cat = 'In Production';
    else cat = cat.charAt(0).toUpperCase() + cat.slice(1);
    return `[${tabName} x ${cat}] Production Schedule.${format}`;
  };

  const exportToCSV = () => {
    if (orders.length === 0) return;

    const headers = [
      'FPR', 'Material Code', 'Item Description', 'Form', 'Total Volume (MT)',
      'Number of Bags', 'Number of Batches', 'Batch Size', 'Target Avail Date',
      'Start Date', 'Start Time', 'Production Hours', 'Changeover Time', 'Run Rate',
      'HA Available', 'Formula Version', 'Prod Version', 'FG', 'SFG', 'SFG1',
      'HA Prep Form Issuance', 'FPR Notes', 'Readiness Status'
    ];

    const calculateBags = (mt) => mt ? Math.round((mt / 50) * 1000) : 0;
    const calculateBatches = (mt, bs) => bs ? Math.ceil(mt / bs) : 0;
    
    const getReadiness = (order) => {
      const numBatches = order.batch_size ? Math.ceil(order.total_volume_mt / order.batch_size) : 0;
      const hasRequired = order.fpr && order.material_code && order.total_volume_mt > 0;
      return hasRequired && order.ha_available === numBatches ? 'OK' : 'Needs Fixing';
    };

    const rows = orders.map(order => [
      order.fpr || '',
      order.material_code || '',
      order.item_description || '',
      order.form || '',
      fmtVolume(order.total_volume_mt || 0),
      fmtBags(calculateBags(order.total_volume_mt)),
      fmtBatches(calculateBatches(order.total_volume_mt, order.batch_size || 4)),
      order.batch_size || 4,
      order.target_avail_date || '',
      order.start_date || '',
      formatTime12(order.start_time) || '',
      fmtHours(order.production_hours || 0),
      fmtChangeover(order.changeover_time || 0.17),
      fmtRunRate(order.run_rate || 0),
      order.ha_available || '',
      order.formula_version || '',
      order.prod_version || '',
      order.fg || '',
      order.sfg || '',
      order.sfg1 || '',
      order.ha_prep_form_issuance || '',
      [order.prod_remarks, order.cancel_note].filter(Boolean).join('\n') || '',
      getReadiness(order)
    ]);

    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = generateFileName('csv');
    link.click();
    URL.revokeObjectURL(link.href);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="gap-2">
          <Download className="h-4 w-4" />
          Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={exportToCSV}>
          Export as CSV
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}