import { AlertTriangle, Clock, XCircle, Activity } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export default function AlertsSection({ orders, lineCapacities }) {
  const now = new Date();
  const twoDaysLater = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);

  const urgentOrders = orders.filter(order => {
    if (!order.target_avail_date || order.status === 'completed') return false;
    try {
      const targetDate = new Date(order.target_avail_date);
      return targetDate <= twoDaysLater && targetDate >= now;
    } catch { return false; }
  });

  const overdueOrders = orders.filter(order => {
    if (!order.target_avail_date || order.status === 'completed') return false;
    try {
      const targetDate = new Date(order.target_avail_date);
      return targetDate < now;
    } catch { return false; }
  });

  const parseCompletionDate = (str) => {
    if (!str) return null;
    try {
      const datePart = str.split(' - ')[0];
      if (!datePart) return null;
      const [m, d, y] = datePart.split('/');
      if (!m || !d || !y) return null;
      const parsed = new Date(parseInt(y), parseInt(m) - 1, parseInt(d));
      return isNaN(parsed.getTime()) ? null : parsed;
    } catch { return null; }
  };

  const completionApproachingOrders = orders.filter(order => {
    if (order.status === 'completed') return false;
    const completionDate = parseCompletionDate(order.target_completion_date);
    if (!completionDate) return false;
    return completionDate <= twoDaysLater && completionDate >= now;
  });

  const completionOverdueOrders = orders.filter(order => {
    if (order.status === 'completed') return false;
    const completionDate = parseCompletionDate(order.target_completion_date);
    if (!completionDate) return false;
    return completionDate < now;
  });

  const getReadinessStatus = (order) => {
    const numBatches = order.batch_size ? Math.ceil(order.total_volume_mt / order.batch_size) : 0;
    const hasRequiredFields =
      order.fpr &&
      order.material_code &&
      order.total_volume_mt > 0;
    const haMatches = order.ha_available === numBatches;
    return hasRequiredFields && haMatches;
  };

  const incompleteOrders = orders.filter(o => !getReadinessStatus(o));

  const fullLines = lineCapacities ? Object.entries(lineCapacities)
    .filter(([_, data]) => data.current >= data.max)
    .map(([line]) => line) : [];

  const alerts = [];

  if (urgentOrders.length > 0) {
    alerts.push({
      type: 'warning',
      icon: AlertTriangle,
      title: 'Urgent Orders',
      description: `${urgentOrders.length} order(s) are due within the next 2 days: ${urgentOrders.map(o => o.item_description || o.material_code).slice(0, 3).join(', ')}${urgentOrders.length > 3 ? '...' : ''}.`,
      color: 'border-orange-200 bg-orange-50 text-orange-800'
    });
  }

  if (completionApproachingOrders.length > 0) {
    alerts.push({
      type: 'warning',
      icon: AlertTriangle,
      title: 'Completion Approaching',
      description: completionApproachingOrders.slice(0, 3).map(o =>
        `${o.fpr || o.material_code} — ${o.item_description} has a target completion date of ${o.target_completion_date}. Consider prioritizing production to avoid missing the ${o.target_avail_date} deadline.`
      ).join(' | ') + (completionApproachingOrders.length > 3 ? `... and ${completionApproachingOrders.length - 3} more` : ''),
      color: 'border-orange-200 bg-orange-50 text-orange-800'
    });
  }

  if (completionOverdueOrders.length > 0) {
    alerts.push({
      type: 'error',
      icon: Clock,
      title: 'Completion Overdue',
      description: completionOverdueOrders.slice(0, 3).map(o =>
        `${o.fpr || o.material_code} — ${o.item_description} has passed its target completion date of ${o.target_completion_date}. The target availability date is ${o.target_avail_date}. Immediate action recommended.`
      ).join(' | ') + (completionOverdueOrders.length > 3 ? `... and ${completionOverdueOrders.length - 3} more` : ''),
      color: 'border-red-200 bg-red-50 text-red-800'
    });
  }

  if (overdueOrders.length > 0) {
    alerts.push({
      type: 'error',
      icon: Clock,
      title: 'Overdue / Stagnant Orders',
      description: `${overdueOrders.length} order(s) have passed their target availability date and are still not completed.`,
      color: 'border-red-200 bg-red-50 text-red-800'
    });
  }

  if (incompleteOrders.length > 0) {
    alerts.push({
      type: 'info',
      icon: XCircle,
      title: 'Incomplete Orders',
      description: `${incompleteOrders.length} order(s) are missing required information and need attention.`,
      color: 'border-gray-200 bg-gray-50 text-gray-700'
    });
  }

  if (fullLines.length > 0) {
    alerts.push({
      type: 'warning',
      icon: Activity,
      title: 'Line Capacity Warning',
      description: `${fullLines.join(', ')} ${fullLines.length > 1 ? 'are' : 'is'} at full capacity. Consider redistributing production.`,
      color: 'border-amber-200 bg-amber-50 text-amber-800'
    });
  }

  if (alerts.length === 0) {
    return (
      <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-center" data-testid="status-no-alerts">
        <p className="text-green-700 text-sm">✓ No alerts at this time. Production schedule is on track.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="section-smart-alerts">
      <h3 className="font-semibold text-gray-900 text-sm">Alerts & Reminders</h3>

      {alerts.map((alert, index) => {
        const Icon = alert.icon;
        return (
          <Alert key={index} className={alert.color} data-testid={`alert-${alert.type}-${index}`}>
            <Icon className="h-4 w-4" />
            <AlertTitle className="text-sm font-medium">{alert.title}</AlertTitle>
            <AlertDescription className="text-xs mt-1">{alert.description}</AlertDescription>
          </Alert>
        );
      })}
    </div>
  );
}
