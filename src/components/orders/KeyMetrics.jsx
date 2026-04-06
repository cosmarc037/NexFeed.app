import React from 'react';
import { ClipboardList, AlertTriangle, Activity, XCircle } from 'lucide-react';
import { Card, CardContent } from "@/components/ui/card";

// Add business days helper
function addBusinessDays(date, days) {
  let d = new Date(date);
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay();
    if (day !== 0 && day !== 6) added++;
  }
  return d;
}

export default function KeyMetrics({ orders }) {
  const totalOrders = orders.length;

  // Active = not completed and not cancelled
  const activeOrders = orders.filter(o => !['completed', 'cancel_po'].includes(o.status)).length;

  // Lacking Details = red X readiness (missing critical fields)
  const lackingDetails = orders.filter(order => {
    const sugVol = (() => {
      const orig = parseFloat(order.total_volume_mt) || 0;
      const bs = parseFloat(order.batch_size) || 4;
      return bs > 0 ? Math.ceil(orig / bs) * bs : orig;
    })();
    return !(
      order.fpr &&
      order.item_description &&
      order.material_code &&
      sugVol > 0 &&
      (parseFloat(order.batch_size) || 0) > 0 &&
      order.start_date &&
      order.start_time &&
      order.production_hours > 0 &&
      (order.changeover_time !== null && order.changeover_time !== undefined && order.changeover_time !== '') &&
      order.run_rate > 0
    );
  }).length;

  // Urgent = avail date within next 2 business days, not completed
  const now = new Date();
  const twoBizDaysLater = addBusinessDays(now, 2);
  const urgentOrders = orders.filter(order => {
    if (['completed', 'cancel_po'].includes(order.status)) return false;
    if (!order.target_avail_date) return false;
    try {
      const targetDate = new Date(order.target_avail_date);
      return !isNaN(targetDate.getTime()) && targetDate >= now && targetDate <= twoBizDaysLater;
    } catch { return false; }
  }).length;

  const metrics = [
    { label: 'Total Orders',    value: totalOrders,    icon: ClipboardList, color: 'text-blue-600',   bgColor: 'bg-blue-50' },
    { label: 'Active Orders',   value: activeOrders,   icon: Activity,      color: 'text-green-600',  bgColor: 'bg-green-50' },
    { label: 'Urgent Orders',   value: urgentOrders,   icon: AlertTriangle, color: 'text-orange-600', bgColor: 'bg-orange-50' },
    { label: 'Lacking Details', value: lackingDetails, icon: XCircle,       color: 'text-red-600',    bgColor: 'bg-red-50' },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      {metrics.map((metric) => {
        const Icon = metric.icon;
        return (
          <Card key={metric.label} className="border-0 shadow-sm">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[12px] text-gray-500">{metric.label}</p>
                  <p className="text-[24px] font-bold text-gray-900">{metric.value}</p>
                </div>
                <div className={`p-2.5 rounded-xl ${metric.bgColor}`}>
                  <Icon className={`h-5 w-5 ${metric.color}`} />
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}